import { formatNumberedLines } from "../util.js";

const PATCH_OP_SCHEMA = {
  type: "object",
  description:
    "یک عملیات پچ: یا { old_text, new_text } برای جایگزینی دقیق متن یکتا، یا { start_line, end_line, expected_first_line, new_text } برای ویرایش بر اساس شماره خط.",
  properties: {
    old_text: { type: "string", description: "متن دقیق و یکتای فعلی (بدون پیشوند 'N | '). برای حذف، new_text را خالی بفرست." },
    new_text: { type: "string", description: "متن جایگزین (بدون پیشوند 'N | '). برای حذف، رشته خالی \"\" بفرست." },
    start_line: { type: "integer", description: "شماره خط شروع (۱-مبنا، از خروجی numbered_body در get_note)." },
    end_line: { type: "integer", description: "شماره خط پایان (اختیاری؛ پیش‌فرض برابر با start_line)." },
    expected_first_line: { type: "string", description: "بخشی از متن مورد انتظار در خط start_line (الزامی در حالت خطی)." },
  },
};

export const definitions = [
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new titled note with markdown body and optional comma-separated tags.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          tags: { type: "string", description: "Comma-separated tags e.g. 'project:foo, type:test'" },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_note",
      description: "Append a dated entry block to an existing note without overwriting its content.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          text: { type: "string" },
          heading: { type: "string", description: "Optional section heading (defaults to current timestamp)" },
        },
        required: ["id", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_note",
      description:
        "Apply targeted atomic patches to an existing note's body (and optionally title/tags) without rewriting the whole note. " +
        "ALWAYS call get_note first to read numbered_body and updated_at. Never include 'N | ' line prefixes inside old_text or new_text.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          edits: {
            type: "array",
            items: PATCH_OP_SCHEMA,
            description: "List of patch operations applied atomically in order.",
          },
          expected_updated_at: {
            type: "integer",
            description: "Optional updated_at timestamp from get_note for optimistic concurrency check.",
          },
          title: { type: "string", description: "Optional new title." },
          tags: { type: "string", description: "Optional new comma-separated tags." },
        },
        required: ["id", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_note",
      description:
        "Full-body replacement of an existing note's title, body, or tags by id. " +
        "WHEN NOT TO USE: Do NOT use edit_note for partial edits or adding sections — prefer patch_note (after get_note) for targeted edits or append_note to add new dated blocks.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          title: { type: "string" },
          body: { type: "string" },
          tags: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Delete a note by id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_note",
      description: "Get a note by id with line-numbered body (numbered_body), line_count, title, tags, and timestamps.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List recent notes in a lightweight format (id, title, tags, updated_at).",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Default 20." },
          tag: { type: "string", description: "Filter by tag substring." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description:
        "Search notes by text query, tags, and/or date range. Returns title + short snippet (not full body; use get_note for full text). " +
        "If 0 matches return, retry with shorter word stems, tag filters, or Persian/Arabic character variants (ی/ي, ک/ك).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text query matching title or body." },
          tags: { type: "string", description: "Filter by tag substring." },
          date_from_iso: { type: "string", description: "Filter notes on/after ISO date string (e.g. '2026-08-01')." },
          date_to_iso: { type: "string", description: "Filter notes on/before ISO date string." },
          date_field: {
            type: "string",
            enum: ["created", "updated"],
            description: "Default 'created'.",
          },
          limit: { type: "integer", description: "Default 10." },
        },
      },
    },
  },
];

export async function execute(name, args, { stub }) {
  switch (name) {
    case "create_note": {
      const note = await stub.createNote({ title: args.title, body: args.body, tags: args.tags });
      return { ok: true, note };
    }
    case "append_note": {
      const note = await stub.appendToNote(args.id, { text: args.text, heading: args.heading });
      return { ok: true, note };
    }
    case "patch_note": {
      const note = await stub.patchNote(args.id, {
        edits: args.edits,
        expectedUpdatedAt: args.expected_updated_at,
        title: args.title,
        tags: args.tags,
      });
      return { ok: true, note };
    }
    case "edit_note": {
      if (args.title === undefined && args.body === undefined && args.tags === undefined) {
        throw new Error("At least one of title, body, or tags is required for edit_note");
      }
      const note = await stub.updateNote(args.id, { title: args.title, body: args.body, tags: args.tags });
      return { ok: true, note };
    }
    case "delete_note": {
      const res = await stub.deleteNote(args.id);
      return { ok: true, ...res };
    }
    case "get_note": {
      const note = await stub.getNote(args.id);
      const lineCount = note.body ? note.body.split("\n").length : 0;
      return {
        ok: true,
        note: {
          id: note.id,
          title: note.title,
          tags: note.tags,
          created_at: note.created_at,
          updated_at: note.updated_at,
          line_count: lineCount,
          numbered_body: formatNumberedLines(note.body),
        },
      };
    }
    case "list_notes": {
      const notes = await stub.listNotesIndex({ limit: args.limit || 20 });
      const filtered = args.tag
        ? notes.filter((n) => n.tags && n.tags.toLowerCase().includes(args.tag.toLowerCase()))
        : notes;
      return { ok: true, count: filtered.length, notes: filtered };
    }
    case "search_notes": {
      const dateFrom = args.date_from_iso ? Date.parse(args.date_from_iso) : undefined;
      const dateTo = args.date_to_iso ? Date.parse(args.date_to_iso) : undefined;
      const results = await stub.searchNotes({
        query: args.query,
        tags: args.tags,
        dateFrom: Number.isNaN(dateFrom) ? undefined : dateFrom,
        dateTo: Number.isNaN(dateTo) ? undefined : dateTo,
        dateField: args.date_field || "created",
        limit: args.limit || 10,
      });
      const matches = results.map((n) => ({
        id: n.id,
        title: n.title,
        tags: n.tags,
        snippet: n.body.length > 150 ? `${n.body.slice(0, 150)}...` : n.body,
        created_at: n.created_at,
        updated_at: n.updated_at,
      }));
      return { ok: true, matches_count: matches.length, matches };
    }
    default:
      throw new Error(`unknown notes tool: ${name}`);
  }
}
