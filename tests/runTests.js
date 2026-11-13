/**
 * Test suite for GalbernAI v2
 * Uses node:sqlite to run real SQL commands against an in-memory SQLite database.
 */

import { DatabaseSync } from "node:sqlite";
import { AgentDO } from "../src/agentDO.js";
import { renderPlanHtml } from "../src/planView.js";
import { markdownToTelegramHtml, splitIntoChunks, sendMarkdown, sendRichMediaGallery } from "../src/telegram.js";
import { publishPlanMessage } from "../src/tools/plan.js";
import { formatHumanDateTime, formatMessageTimestamp, formatNumberedLines, applySafePatches } from "../src/util.js";
import { buildHistoryMessages, buildSystemPrompt, compressSandboxResult, runAgentTurnLocked } from "../src/agentLoop.js";
import { execute as executeNotesTool } from "../src/tools/notes.js";
import { execute as executeMemoryTool } from "../src/tools/memory.js";
import { execute as executeSandboxTool } from "../src/tools/sandbox.js";
import { checkRollover } from "../src/cron.js";
import { renderNotesPageRich } from "../src/index.js";

// Mock Cloudflare SQL execution interface
class MockSql {
  constructor(db) {
    this.db = db;
  }
  exec(sql, ...params) {
    const trimmed = sql.trim();
    if (params.length > 0) {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params);
      return { toArray: () => rows };
    } else {
      const isSelect = trimmed.toUpperCase().startsWith("SELECT") || trimmed.toUpperCase().startsWith("WITH");
      if (isSelect) {
        const stmt = this.db.prepare(sql);
        const rows = stmt.all();
        return { toArray: () => rows };
      } else {
        try {
          const stmt = this.db.prepare(sql);
          const rows = stmt.all();
          return { toArray: () => rows };
        } catch (e) {
          this.db.exec(sql);
          return { toArray: () => [] };
        }
      }
    }
  }
}

async function runTests() {
  console.log("=== Starting GalbernAI v2 Unit Tests ===");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // Test 1: Migration & SQLite DB Operations
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 1: Migration (Old DB vs Fresh DB) ---");
    // 1. Old DB simulation
    const dbOld = new DatabaseSync(":memory:");
    const oldSCHEMA = `
    CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kv_meta (key TEXT PRIMARY KEY, value TEXT);
    `;
    dbOld.exec(oldSCHEMA);
    dbOld.prepare("INSERT INTO plans (goal, status, created_at) VALUES ('Old Goal', 'active', 1000)").run();
    dbOld.prepare("INSERT INTO notes (title, body, created_at, updated_at) VALUES ('Old Note', 'Body content', 1000, 1000)").run();

    const mockCtxOld = {
      storage: { sql: new MockSql(dbOld) },
      blockConcurrencyWhile: async (fn) => await fn(),
    };
    const agentOld = new AgentDO(mockCtxOld, {});
    
    // Check migrated columns
    const planRows = dbOld.prepare("SELECT * FROM plans").all();
    assert("telegram_message_id" in planRows[0], "Old DB plans table migrated with telegram_message_id column");
    assert(planRows[0].goal === "Old Goal", "Old DB plan data preserved");

    const noteRows = dbOld.prepare("SELECT * FROM notes").all();
    assert("tags" in noteRows[0], "Old DB notes table migrated with tags column");
    assert(noteRows[0].title === "Old Note", "Old DB note data preserved");

    // Re-instantiate on same DB (idempotent check)
    const agentOldAgain = new AgentDO(mockCtxOld, {});
    assert(true, "Re-instantiating AgentDO on migrated DB is idempotent (no duplicate column errors)");

    // 2. Fresh DB simulation
    const dbFresh = new DatabaseSync(":memory:");
    const mockCtxFresh = {
      storage: { sql: new MockSql(dbFresh) },
      blockConcurrencyWhile: async (fn) => await fn(),
    };
    const agentFresh = new AgentDO(mockCtxFresh, {});
    assert(true, "AgentDO instantiation on fresh DB succeeds without error");
  } catch (err) {
    console.error("Test 1 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 2: Pinned Plan Logic & rendering
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 2: Pinned Plan & HTML Rendering ---");
    const db = new DatabaseSync(":memory:");
    const mockCtx = { storage: { sql: new MockSql(db) }, blockConcurrencyWhile: async (fn) => await fn() };
    const agent = new AgentDO(mockCtx, {});

    const created = agent.createPlan({ goal: "تست برنامه", items: ["گام اول", "گام دوم"] });
    assert(created.plan.id === 1, "Plan created with id 1");
    assert(created.items.length === 2, "Plan has 2 items");

    const render1 = renderPlanHtml(created);
    assert(render1.includes("🧭 <b>برنامه‌ی فعال</b>"), "HTML header contains active plan emoji");
    assert(render1.includes("1. ▫️ گام اول"), "Item 1 uncompleted format");

    // Complete item 1
    const comp1 = agent.completePlanItem(created.items[0].id);
    assert(comp1.planCompleted === false, "Plan is not completed after item 1");
    assert(comp1.planId === 1, "completePlanItem returns planId");

    const snapshot1 = agent.getPlanById(1);
    const render2 = renderPlanHtml(snapshot1);
    assert(render2.includes("1. ✅ <s>گام اول</s>"), "Item 1 completed html format");

    // Complete item 2
    const comp2 = agent.completePlanItem(created.items[1].id);
    assert(comp2.planCompleted === true, "Plan completed after final item");

    const snapshot2 = agent.getPlanById(1);
    const render3 = renderPlanHtml(snapshot2);
    assert(render3.includes("🎉 <b>برنامه تکمیل شد</b>"), "HTML header shows completed message");

    // Long plan truncation test - lines omitted cleanly without broken tags
    const longItems = Array.from({ length: 100 }, (_, i) => `یک گام خیلی خیلی طولانی برای برنامه شماره ${i} جهت بررسی سقف ۳۴۰۰ کاراکتر`);
    db.exec("DELETE FROM plan_items; DELETE FROM plans;");
    const longPlan = agent.createPlan({ goal: "برنامه‌ی طولانی", items: longItems });
    const longRender = renderPlanHtml(longPlan);
    assert(longRender.length <= 3400, "Rendered HTML is truncated to <= 3400 characters");
    assert(longRender.includes("آیتم دیگر"), "Truncated HTML includes omitted items line cleanly");
    
    // Validate tag balance in longRender
    const openS = (longRender.match(/<s>/g) || []).length;
    const closeS = (longRender.match(/<\/s>/g) || []).length;
    assert(openS === closeS, "Rendered HTML has balanced <s> and </s> tags");

    const openB = (longRender.match(/<b>/g) || []).length;
    const closeB = (longRender.match(/<\/b>/g) || []).length;
    assert(openB === closeB, "Rendered HTML has balanced <b> and </b> tags");
  } catch (err) {
    console.error("Test 2 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 3: publishPlanMessage with Mock fetch
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 3: publishPlanMessage lifecycle & Telegram mock ---");
    const db = new DatabaseSync(":memory:");
    const mockCtx = { storage: { sql: new MockSql(db) }, blockConcurrencyWhile: async (fn) => await fn() };
    const agent = new AgentDO(mockCtx, {});
    const p = agent.createPlan({ goal: "برنامه تستی", items: ["آیتم اول", "آیتم دوم"] });

    const fetchCalls = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, opts) => {
      const urlStr = String(url);
      fetchCalls.push({ url: urlStr, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });

      if (urlStr.includes("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 12345 } }));
      }
      if (urlStr.includes("/pinChatMessage")) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      if (urlStr.includes("/editMessageText")) {
        const body = JSON.parse(opts.body);
        if (body.text.includes("TRIGGER_NOT_FOUND")) {
          return new Response(JSON.stringify({ ok: false, description: "Bad Request: message to edit not found" }), { status: 400 });
        }
        if (body.text.includes("TRIGGER_NOT_MODIFIED")) {
          return new Response(JSON.stringify({ ok: false, description: "Bad Request: message is not modified" }), { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: body.message_id } }));
      }
      if (urlStr.includes("/unpinChatMessage")) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      return new Response(JSON.stringify({ ok: true }));
    };

    const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
    const chatId = 9999;

    // (الف) Create: exactly 1 sendMessage + 1 pinChatMessage, telegram_message_id stored
    const msgId1 = await publishPlanMessage(mockEnv, agent, chatId, p.plan.id);
    assert(msgId1 === 12345, "publishPlanMessage created message 12345");
    const sendCalls = fetchCalls.filter(c => c.url.includes("/sendMessage"));
    const pinCalls = fetchCalls.filter(c => c.url.includes("/pinChatMessage"));
    assert(sendCalls.length === 1, "Exactly one sendMessage call");
    assert(pinCalls.length === 1, "Exactly one pinChatMessage call");

    const savedPlan1 = agent.getPlanById(p.plan.id);
    assert(savedPlan1.plan.telegram_message_id === 12345, "telegram_message_id saved in SQL");

    // (ب) Edit: only editMessageText, no new sendMessage
    fetchCalls.length = 0;
    const editId = await publishPlanMessage(mockEnv, agent, chatId, p.plan.id);
    assert(editId === 12345, "publishPlanMessage returned existing message_id");
    const sendCallsAfterEdit = fetchCalls.filter(c => c.url.includes("/sendMessage"));
    const editCalls = fetchCalls.filter(c => c.url.includes("/editMessageText"));
    assert(sendCallsAfterEdit.length === 0, "No new sendMessage on edit");
    assert(editCalls.length === 1, "Exactly one editMessageText call");

    // (ج) "message is not modified" -> no new message created
    fetchCalls.length = 0;
    // Temporarily mutate goal to include TRIGGER_NOT_MODIFIED
    agent.ctx.storage.sql.exec("UPDATE plans SET goal = 'TRIGGER_NOT_MODIFIED' WHERE id = ?", p.plan.id);
    const notModifiedId = await publishPlanMessage(mockEnv, agent, chatId, p.plan.id);
    assert(notModifiedId === 12345, "Returned existing id on message is not modified");
    const sendCallsNotMod = fetchCalls.filter(c => c.url.includes("/sendMessage"));
    assert(sendCallsNotMod.length === 0, "No new message created when not modified");

    // (د) "message to edit not found" -> recreate and pin
    fetchCalls.length = 0;
    agent.ctx.storage.sql.exec("UPDATE plans SET goal = 'TRIGGER_NOT_FOUND' WHERE id = ?", p.plan.id);
    const recreatedId = await publishPlanMessage(mockEnv, agent, chatId, p.plan.id);
    assert(recreatedId === 12345, "New message published after message not found");
    const sendCallsRecreated = fetchCalls.filter(c => c.url.includes("/sendMessage"));
    const pinCallsRecreated = fetchCalls.filter(c => c.url.includes("/pinChatMessage"));
    assert(sendCallsRecreated.length === 1, "Recreated via sendMessage");
    assert(pinCallsRecreated.length === 1, "Recreated message pinned");

    globalThis.fetch = originalFetch;
  } catch (err) {
    console.error("Test 3 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 4: Notes (tags, append_note, 100k length guard, search_notes, Arabic Persian FTS)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 4: Notes Enhancements & Persian FTS ---");
    const db = new DatabaseSync(":memory:");
    const mockCtx = { storage: { sql: new MockSql(db) }, blockConcurrencyWhile: async (fn) => await fn() };
    const agent = new AgentDO(mockCtx, {});

    const n1 = agent.createNote({ title: "یادداشت اول", body: "متن اولیه", tags: "project:galbern, type:test" });
    assert(n1.id === 1, "Note 1 created");
    assert(n1.tags === "project:galbern, type:test", "Note 1 tags stored");

    const appended = agent.appendToNote(1, { text: "نتیجه‌ی تست جدید", heading: "تست ۱" });
    assert(appended.id === 1, "appendToNote returns note");
    
    const fetched = agent.getNote(1);
    assert(fetched.body.includes("متن اولیه"), "Original body retained");
    assert(fetched.body.includes("---"), "Separator block appended");
    assert(fetched.body.includes("تست ۱"), "Heading appended");
    assert(fetched.body.includes("نتیجه‌ی تست جدید"), "Appended text present");

    // 100k length guard
    agent.ctx.storage.sql.exec("UPDATE notes SET body = ? WHERE id = 1", "x".repeat(100_001));
    let guardHit = false;
    try {
      agent.appendToNote(1, { text: "extra" });
    } catch (err) {
      if (err.message.includes("۱۰۰ هزار کاراکتر")) guardHit = true;
    }
    assert(guardHit, "100k character length guard prevents further append");

    // append to non-existent note
    let appendError = false;
    try {
      agent.appendToNote(999, { text: "xyz" });
    } catch {
      appendError = true;
    }
    assert(appendError, "appendToNote on non-existent note throws error");

    // listNotesIndex
    const indexList = agent.listNotesIndex({ limit: 10 });
    assert(indexList.length === 1, "listNotesIndex returns 1 item");
    assert(indexList[0].id === 1 && "tags" in indexList[0], "listNotesIndex includes tags");

    // searchNotes with tags
    const searchRes = agent.searchNotes({ tags: "galbern" });
    assert(searchRes.length === 1, "searchNotes by tag finds matching note");

    const searchResNone = agent.searchNotes({ tags: "nonexistenttag" });
    assert(searchResNone.length === 0, "searchNotes by non-existent tag returns empty");

    // Arabic / Persian character test
    agent.createNote({ title: "فهرست کلیدها", body: "شامل کلیدهای مهم", tags: "keys" });
    const exactPersianSearch = agent.searchNotes({ query: "کلیدها" });
    assert(exactPersianSearch.length >= 1, "Persian search 'کلیدها' finds note with exact characters");
    const arabicSearch = agent.searchNotes({ query: "كليدها" }); // Arabic yeh/kaf
    console.log(`ℹ️ [FTS Info] Arabic query 'كليدها' against Persian 'کلیدها' found: ${arabicSearch.length} results`);
    // Documenting behavior: SQLite default FTS doesn't normalize Arabic/Persian characters
  } catch (err) {
    console.error("Test 4 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 5: Helper pure functions (HTML/Markdown splitting)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 5: Pure Functions (Markdown/HTML) ---");
    const md = "**سلام** `کد تست`";
    const html = markdownToTelegramHtml(md);
    assert(html.includes("<b>سلام</b>"), "Markdown bold converted to HTML <b>");
    assert(html.includes("<code>کد تست</code>"), "Markdown inline code converted to HTML <code>");

    const longHtml = "<b>" + "متن تست ".repeat(800) + "</b>";
    const chunks = splitIntoChunks(longHtml, 1000);
    assert(chunks.length > 1, "Long HTML string split into multiple chunks");
    assert(chunks[0].endsWith("</b>"), "Chunk 1 safely closes HTML tags");
    assert(chunks[1].startsWith("<b>"), "Chunk 2 safely reopens HTML tags");
  } catch (err) {
    console.error("Test 5 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 6: Midnight hourCycle h23, Per-Message Timestamps & buildHistoryMessages
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 6: Timestamps (00:15 h23) & buildHistoryMessages ---");
    const midnightMs = Date.parse("2026-06-15T00:15:00+03:30");
    const tehranFormatted = formatHumanDateTime(midnightMs, "Asia/Tehran");
    assert(tehranFormatted.includes("00:15"), `formatHumanDateTime renders 00:15 (got: ${tehranFormatted})`);
    assert(!tehranFormatted.includes("24:15"), "formatHumanDateTime never produces 24:15");

    const stamp = formatMessageTimestamp(midnightMs);
    assert(stamp.startsWith("[🕒 ایران:") && stamp.includes("آمریکا:"), "formatMessageTimestamp contains both Iran and US timestamps");

    const db = new DatabaseSync(":memory:");
    const mockCtx = { storage: { sql: new MockSql(db) }, blockConcurrencyWhile: async (fn) => await fn() };
    const agent = new AgentDO(mockCtx, {});

    const dayWin = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(Date.now());
    agent.appendMessage({ dayWindow: dayWin, role: "user", content: "سلام" });
    agent.appendMessage({ dayWindow: dayWin, role: "user", content: "", mediaRefs: [{ fileId: "sandbox:test:photo.jpg", kind: "image", mimeType: "image/jpeg" }] });
    agent.setCachedMedia("sandbox:test:photo.jpg", "AAAA", "image/jpeg");
    agent.appendMessage({ dayWindow: dayWin, role: "assistant", content: "", toolCalls: [{ id: "tc1", type: "function", function: { name: "list_notes", arguments: "{}" } }] });
    agent.appendMessage({ dayWindow: dayWin, role: "tool", toolCallId: "tc1", toolName: "list_notes", content: '{"ok":true}' });
    agent.appendMessage({ dayWindow: dayWin, role: "assistant", content: "اینجا جواب نهایی است." });

    const history = await buildHistoryMessages(agent, {});
    assert(history.length === 5, `buildHistoryMessages returns 5 messages (got ${history.length})`);
    assert(typeof history[0].content === "string" && history[0].content.startsWith("[🕒 ایران:") && history[0].content.endsWith("\nسلام"), "User text turn has timestamp prefix");
    assert(Array.isArray(history[1].content) && history[1].content[0].type === "text" && history[1].content[0].text.startsWith("[🕒 ایران:") && history[1].content[1].type === "image_url", "Photo-only turn has timestamp text part and image_url part");
    assert(history[2].role === "assistant" && history[2].content === "" && Array.isArray(history[2].tool_calls), "Empty tool-calling assistant turn kept untouched without timestamp");
    assert(history[3].role === "tool" && history[3].content === '{"ok":true}', "Tool turn untouched");
    assert(history[4].role === "assistant" && history[4].content.startsWith("[🕒 ایران:") && history[4].content.endsWith("\nاینجا جواب نهایی است."), "Non-empty assistant turn has timestamp prefix");
  } catch (err) {
    console.error("Test 6 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 7: formatNumberedLines, applySafePatches, patchNote & patchMemoryProfile
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 7: Line-Numbered Views & Safe Patching ---");
    const numbered = formatNumberedLines("خط اول\nخط دوم\nخط سوم");
    assert(numbered === "1 | خط اول\n2 | خط دوم\n3 | خط سوم", "formatNumberedLines formats 1-based lines");

    const db = new DatabaseSync(":memory:");
    const mockCtx = { storage: { sql: new MockSql(db) }, blockConcurrencyWhile: async (fn) => await fn() };
    const agent = new AgentDO(mockCtx, {});

    const created = agent.createNote({
      title: "راهنمای تست",
      body: "بخش اول\nمقدار قدیمی\nبخش دوم\nمقدار قدیمی\nپایان",
      tags: "type:test",
    });

    // stub.getNote keeps raw unnumbered body, while tools/notes.js get_note returns numbered_body
    const rawNote = agent.getNote(created.id);
    assert(!rawNote.body.includes("1 | "), "stub.getNote returns raw unnumbered body for UI");
    const toolNoteRes = await executeNotesTool("get_note", { id: created.id }, { stub: agent });
    assert(toolNoteRes.ok && toolNoteRes.note.line_count === 5 && toolNoteRes.note.numbered_body.startsWith("1 | بخش اول"), "tools/notes.js get_note returns numbered_body and line_count");

    // Exact unique old_text patch succeeds & updates updated_at
    const beforeUpdatedAt = rawNote.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    const patched1 = agent.patchNote(created.id, {
      edits: [{ old_text: "بخش اول\nمقدار قدیمی", new_text: "بخش اول\nمقدار جدید" }],
    });
    assert(patched1.updated_at >= beforeUpdatedAt, "patchNote updates updated_at");
    assert(agent.getNote(created.id).body.includes("مقدار جدید"), "Exact old_text patch applied in DB");

    // Missing old_text throws without mutating DB
    const bodyBeforeFail = agent.getNote(created.id).body;
    let missingThrew = false;
    try {
      agent.patchNote(created.id, { edits: [{ old_text: "عبارت ناموجود", new_text: "تست" }] });
    } catch {
      missingThrew = true;
    }
    assert(missingThrew && agent.getNote(created.id).body === bodyBeforeFail, "Missing old_text throws without mutating DB");

    // Ambiguous old_text throws without mutating DB
    agent.updateNote(created.id, { body: "تکرار\nمیانه\nتکرار" });
    let ambiguousThrew = false;
    try {
      agent.patchNote(created.id, { edits: [{ old_text: "تکرار", new_text: "تغییر" }] });
    } catch {
      ambiguousThrew = true;
    }
    assert(ambiguousThrew && agent.getNote(created.id).body === "تکرار\nمیانه\nتکرار", "Ambiguous old_text throws without mutating DB");

    // Line-range patch succeeds with matching expected_first_line
    agent.updateNote(created.id, { body: "خط ۱\nخط ۲\nخط ۳\nخط ۴" });
    const linePatched = await executeNotesTool(
      "patch_note",
      {
        id: created.id,
        edits: [{ start_line: 2, end_line: 3, expected_first_line: "خط ۲", new_text: "خط ۲ اصلاح‌شده\nخط ۳ اصلاح‌شده" }],
      },
      { stub: agent }
    );
    assert(linePatched.ok && agent.getNote(created.id).body === "خط ۱\nخط ۲ اصلاح‌شده\nخط ۳ اصلاح‌شده\nخط ۴", "Line-range patch succeeds with matching expected_first_line");

    // Off-by-one mismatch rejects with numbered context preview
    let mismatchErr = "";
    try {
      agent.patchNote(created.id, {
        edits: [{ start_line: 1, end_line: 1, expected_first_line: "خط ۲", new_text: "خراب" }],
      });
    } catch (err) {
      mismatchErr = err.message;
    }
    assert(mismatchErr.includes("expected_first_line") && mismatchErr.includes("1 | خط ۱"), "Off-by-one mismatch rejects with numbered context preview");

    // Reject accidental 1 | line-prefix leaks
    let prefixLeakThrew = false;
    try {
      applySafePatches("الف\nب", [{ old_text: "1 | الف\n2 | ب", new_text: "ج" }]);
    } catch (err) {
      prefixLeakThrew = err.message.includes("پیشوند شماره خط");
    }
    assert(prefixLeakThrew, "Rejects accidental '1 | ' line-prefix leaks in old_text");

    let newPrefixLeakThrew = false;
    try {
      applySafePatches("الف\nب", [{ start_line: 1, end_line: 2, expected_first_line: "الف", new_text: "1 | ج\n2 | د" }]);
    } catch (err) {
      newPrefixLeakThrew = err.message.includes("پیشوند شماره خط");
    }
    assert(newPrefixLeakThrew, "Rejects accidental '1 | ' line-prefix leaks in new_text");

    // patchMemoryProfile & buildSystemPrompt XML tags
    agent.setMemoryProfile("نام: علی\nشهر: تهران");
    const memPatched = await executeMemoryTool(
      "patch_memory",
      { edits: [{ old_text: "شهر: تهران", new_text: "شهر: شیراز" }] },
      { stub: agent, env: {} }
    );
    assert(memPatched.ok && agent.getMemoryProfile() === "نام: علی\nشهر: شیراز", "patch_memory updates memory_profile cleanly");
    const sysPrompt = await buildSystemPrompt(agent);
    assert(
      sysPrompt.includes("<clock>") &&
      sysPrompt.includes("<user_profile") &&
      sysPrompt.includes("1 | نام: علی\n2 | شهر: شیراز") &&
      sysPrompt.includes("<notes_index"),
      "buildSystemPrompt uses XML tags and numbered <user_profile>"
    );
  } catch (err) {
    console.error("Test 7 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 8: [SILENT] handling in runAgentTurnLocked (proactive_wake)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 8: [SILENT] handling in proactive_wake ---");
    const db = new DatabaseSync(":memory:");
    const mockCtx = { storage: { sql: new MockSql(db) }, blockConcurrencyWhile: async (fn) => await fn() };
    const agent = new AgentDO(mockCtx, {});

    const tgCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      tgCalls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    };

    const mockEnv = {
      TELEGRAM_BOT_TOKEN: "mock_token",
      AI_ROUTER_BASE_URL: "https://router.example",
      AI_ROUTER_PROXY_TOKEN: "tok",
      HERMES_ROUTER: {
        fetch: async () =>
          new Response(JSON.stringify({
            choices: [{ message: { role: "assistant", content: "[SILENT]" } }],
          })),
      },
    };

    await runAgentTurnLocked({
      env: mockEnv,
      ctx: mockCtx,
      stub: agent,
      chatId: 12345,
      trigger: { kind: "proactive_wake", theme: "چک روزانه" },
    });

    globalThis.fetch = originalFetch;

    const msgs = db.prepare("SELECT * FROM messages ORDER BY id ASC").all();
    const lastMsg = msgs[msgs.length - 1];
    assert(tgCalls.length === 0, `[SILENT] triggers 0 Telegram sends (got ${tgCalls.length})`);
    assert(lastMsg && lastMsg.role === "assistant" && lastMsg.content === "[سکوت خودکار — پیامی ارسال نشد]", "Closed assistant turn recorded in SQLite instead of raw [SILENT]");
  } catch (err) {
    console.error("Test 8 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 9: compressSandboxResult sends full >50,000-char stdout without truncation
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 9: compressSandboxResult (>50,000 chars, no slicing) ---");
    const marker = "TAIL_MARKER_65000_CHARS";
    const bigStdout = Array.from({ length: 1200 }, (_, i) => `line_${i}_${"a".repeat(50)}`).join("\n") + `\n${marker}`;
    assert(bigStdout.length > 55000, `Test payload exceeds 50,000 chars (${bigStdout.length})`);

    let capturedPrompt = "";
    const mockEnv = {
      AI_ROUTER_BASE_URL: "https://router.example",
      AI_ROUTER_PROXY_TOKEN: "tok",
      HERMES_ROUTER: {
        fetch: async (_url, opts) => {
          const body = JSON.parse(opts.body);
          capturedPrompt = body.messages[0].content;
          return new Response(JSON.stringify({
            choices: [{ message: { content: `compressed:${marker}` } }],
          }));
        },
      },
    };

    const compressed = await compressSandboxResult(mockEnv, { ok: true, stdout: bigStdout, stderr: "", exitCode: 0 });
    assert(capturedPrompt.includes(marker), "compressSandboxResult passes full >50,000-char stdout to fast model without truncation");
    assert(compressed.summarized === true && compressed.stdout.includes(marker), "compressSandboxResult returns fast model output");
  } catch (err) {
    console.error("Test 9 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 10: sendMarkdown Rich routing + HTTP 400 fallback
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 10: sendMarkdown Rich Routing & Fallback ---");
    const originalFetch = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes("/sendRichMessage")) {
        if (body?.rich_message?.markdown?.includes("FORCE_400")) {
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request" }), { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }));
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 78 } }));
    };

    const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
    const tableMd = "| نام | مقدار |\n| --- | --- |\n| تست | ۱۰۰ |";

    const res1 = await sendMarkdown(mockEnv, 111, tableMd);
    assert(res1?.ok && calls.length === 1 && calls[0].url.includes("/sendRichMessage"), "Table markdown routes to /sendRichMessage");
    assert(calls[0].body.rich_message?.is_rtl === true, "sendRichMessage sets is_rtl: true");

    calls.length = 0;
    const longMd = "متن طولانی ".repeat(500);
    const res2 = await sendMarkdown(mockEnv, 111, longMd);
    assert(res2?.ok && calls[0].url.includes("/sendRichMessage"), "Long markdown (>3500 chars) routes to /sendRichMessage");

    calls.length = 0;
    const resFallback = await sendMarkdown(mockEnv, 111, "| A | B |\n| - | - |\n| FORCE_400 | 1 |");
    assert(
      resFallback?.ok &&
      calls.length === 2 &&
      calls[0].url.includes("/sendRichMessage") &&
      calls[1].url.includes("/sendMessage"),
      "sendMarkdown falls back to /sendMessage when /sendRichMessage returns HTTP 400"
    );

    globalThis.fetch = originalFetch;
  } catch (err) {
    console.error("Test 10 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 11: sendRichMediaGallery (>20 batching, no <tg-emoji> / icon_custom_emoji_id)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 11: sendRichMediaGallery >20 Batching & No Premium Tags ---");
    const originalFetch = globalThis.fetch;
    const richPayloads = [];

    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("/sendRichMessage") && opts?.body instanceof FormData) {
        const richJson = JSON.parse(opts.body.get("rich_message"));
        richPayloads.push(richJson);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }));
    };

    const items = Array.from({ length: 25 }, (_, i) => ({
      bytes: new Uint8Array([1, 2, 3, i]),
      mimeType: "image/jpeg",
      filename: `img${i}.jpg`,
    }));

    const res = await sendRichMediaGallery({ TELEGRAM_BOT_TOKEN: "mock_token" }, 222, items, {
      mode: "collage",
      caption: "گالری تست",
    });

    globalThis.fetch = originalFetch;

    assert(res?.ok, "sendRichMediaGallery succeeds");
    assert(richPayloads.length === 2, `25 photos split into 2 batches (got ${richPayloads.length})`);
    assert(richPayloads[0].media.length === 20, "Batch 1 has exactly 20 media items");
    assert(richPayloads[1].media.length === 5, "Batch 2 has remaining 5 media items");
    assert(richPayloads[0].html.includes("<tg-collage>") && richPayloads[0].html.includes("<figcaption>گالری تست</figcaption>"), "Collage tag and caption emitted cleanly");
    const serialized = JSON.stringify(richPayloads);
    assert(!serialized.includes("tg-emoji") && !serialized.includes("icon_custom_emoji_id"), "Never emits <tg-emoji> or icon_custom_emoji_id");
  } catch (err) {
    console.error("Test 11 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 12: Rich /notes HTML rendering (<tg-button-row> outside tables, styles)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 12: Rich /notes HTML Rendering ---");
    const db = new DatabaseSync(":memory:");
    const mockCtx = { storage: { sql: new MockSql(db) }, blockConcurrencyWhile: async (fn) => await fn() };
    const agent = new AgentDO(mockCtx, {});
    agent.createNote({ title: "یادداشت نمونه", body: "متن تستی", tags: "project:demo" });

    const rendered = await renderNotesPageRich(agent, 1);
    assert(rendered.is_rtl === true, "renderNotesPageRich sets is_rtl: true");
    assert(rendered.html.includes("<tg-button-row"), "renderNotesPageRich uses <tg-button-row>");
    assert(rendered.html.includes('style="primary"') && rendered.html.includes('style="danger"'), "Buttons use style=\"primary\" and style=\"danger\"");
    assert(!rendered.html.includes("<table") && !rendered.html.includes("<td"), "No buttons inside <table> cells");
    assert(!rendered.html.includes("tg-emoji") && !rendered.html.includes("icon_custom_emoji_id"), "No Telegram Premium tags in /notes UI");
  } catch (err) {
    console.error("Test 12 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 13: checkRollover window-only Vectorize summary & timestamps
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 13: checkRollover Timestamps & Window-Only Vectorize ---");
    const db = new DatabaseSync(":memory:");
    const mockCtx = { storage: { sql: new MockSql(db) }, blockConcurrencyWhile: async (fn) => await fn() };
    const agent = new AgentDO(mockCtx, {});

    // Seed an existing cumulative rollup (Day 1..3) and old messages on Day 4
    agent.setCurrentRollup({
      coversFromDay: "2020-01-01",
      coversToDay: "2020-01-03",
      summary: "خلاصه قدیمی روز ۱ تا ۳",
      windowSummary: "پنجره قدیمی",
      vectorId: "vec-old",
    });
    agent.appendMessage({ dayWindow: "2020-01-04", role: "user", content: "قرار فردا ساعت ۱۰" });
    agent.appendMessage({ dayWindow: "2020-01-04", role: "assistant", content: "ثبت کردم." });

    const llmPrompts = [];
    const embeddedTexts = [];
    const upsertedVectors = [];

    const mockEnv = {
      AI_ROUTER_BASE_URL: "https://router.example",
      AI_ROUTER_PROXY_TOKEN: "tok",
      HERMES_ROUTER: {
        fetch: async (url, opts) => {
          const body = JSON.parse(opts.body);
          if (String(url).includes("/v1/chat/completions")) {
            const p = body.messages[0].content;
            llmPrompts.push(p);
            const isWindowOnly = !p.includes("خلاصه قدیمی روز ۱ تا ۳");
            return new Response(JSON.stringify({
              choices: [{ message: { content: isWindowOnly ? "خلاصه پنجره‌ای روز ۴" : "خلاصه تجمعی روز ۱ تا ۴" } }],
            }));
          }
          if (String(url).includes("/v1/embeddings")) {
            embeddedTexts.push(body.input);
            return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
          }
          return new Response("{}", { status: 404 });
        },
      },
      MEMORY_INDEX: {
        upsert: async (items) => upsertedVectors.push(...items),
      },
    };

    await checkRollover(mockEnv, mockCtx, agent);

    assert(llmPrompts.length === 2, "checkRollover runs cumulative + window-only summarization calls when previous rollup exists");
    assert(llmPrompts[0].includes("قرار فردا ساعت ۱۰") && /\[\w+, /.test(llmPrompts[0]), "conversationText includes message timestamps");
    assert(agent.getCurrentRollup().summary === "خلاصه تجمعی روز ۱ تا ۴", "System prompt currentRollup keeps cumulative summary");
    assert(embeddedTexts[0] === "خلاصه پنجره‌ای روز ۴", "Vectorize embeds window-only summary instead of cumulative rollup");
    assert(upsertedVectors.length === 1 && upsertedVectors[0].metadata.covers_from_day === "2020-01-04", "Vectorize metadata records window start day");
  } catch (err) {
    console.error("Test 13 failed:", err);
    failed++;
  }

  console.log("\n=== Unit Tests Summary ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed === 0) {
    console.log("🚀 All GalbernAI v2 tests passed successfully!");
    process.exit(0);
  } else {
    console.error(`💥 ${failed} test(s) failed.`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
