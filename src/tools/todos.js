// Todos are independent, multiple-at-once reminders. Each MUST have a due
// time. When that time arrives, the agent is woken up with a synthetic
// tool-call/tool-result pair (see cron.js) rather than a hardcoded push
// message - the model decides what to actually say.

export const definitions = [
  {
    type: "function",
    function: {
      name: "create_todo",
      description:
        "Create a time-based reminder for yourself. At the due time, you will be woken up and told the reminder fired - you then decide what (if anything) to say to the user. Use this proactively when you notice something worth remembering for later, even without being asked.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the reminder." },
          description: { type: "string", description: "Extra context to help you know what to do/say when it fires." },
          due_at_iso: {
            type: "string",
            description:
              "ISO 8601 datetime WITH an explicit UTC offset, e.g. '2026-09-01T14:30:00+03:30' for 2:30pm Tehran time. Always include the offset - never a bare local time.",
          },
        },
        required: ["title", "due_at_iso"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "List reminders, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "fired", "done", "cancelled"], description: "Omit to list all." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_todo",
      description: "Edit an existing reminder's title, description, due time, or status.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          title: { type: "string" },
          description: { type: "string" },
          due_at_iso: { type: "string", description: "ISO 8601 with explicit UTC offset." },
          status: { type: "string", enum: ["pending", "fired", "done", "cancelled"] },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_todo",
      description: "Permanently delete a reminder.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
    },
  },
];

export async function execute(name, args, { stub }) {
  switch (name) {
    case "create_todo": {
      const dueAt = Date.parse(args.due_at_iso);
      if (Number.isNaN(dueAt)) throw new Error(`due_at_iso "${args.due_at_iso}" could not be parsed - must be ISO 8601 with a UTC offset.`);
      const todo = await stub.createTodo({ title: args.title, description: args.description || null, dueAt });
      return { ok: true, todo };
    }
    case "list_todos": {
      const todos = await stub.listTodos({ status: args.status || null });
      return { ok: true, todos };
    }
    case "edit_todo": {
      const patch = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.status !== undefined) patch.status = args.status;
      if (args.due_at_iso !== undefined) {
        const dueAt = Date.parse(args.due_at_iso);
        if (Number.isNaN(dueAt)) throw new Error(`due_at_iso "${args.due_at_iso}" could not be parsed.`);
        patch.dueAt = dueAt;
      }
      const todo = await stub.updateTodo(args.id, patch);
      return { ok: true, todo };
    }
    case "delete_todo": {
      const result = await stub.deleteTodo(args.id);
      return result;
    }
    default:
      throw new Error(`unknown todos tool: ${name}`);
  }
}
