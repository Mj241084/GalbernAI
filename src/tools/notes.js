export const definitions = [
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new titled note with markdown body.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_note",
      description: "Edit an existing note by id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          title: { type: "string" },
          body: { type: "string" },
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
      description: "Get the full title, body, and dates of a note by id.",
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
      name: "search_notes",
      description:
        "Search notes by text query and/or date range. Returns title + short snippet (not full body; use get_note for full text).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text query matching title or body." },
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
      const note = await stub.createNote({ title: args.title, body: args.body });
      return { ok: true, note };
    }
    case "edit_note": {
      if (args.title === undefined && args.body === undefined) {
        throw new Error("At least one of title or body is required for edit_note");
      }
      const note = await stub.updateNote(args.id, { title: args.title, body: args.body });
      return { ok: true, note };
    }
    case "delete_note": {
      const res = await stub.deleteNote(args.id);
      return { ok: true, ...res };
    }
    case "get_note": {
      const note = await stub.getNote(args.id);
      return { ok: true, note };
    }
    case "search_notes": {
      const dateFrom = args.date_from_iso ? Date.parse(args.date_from_iso) : undefined;
      const dateTo = args.date_to_iso ? Date.parse(args.date_to_iso) : undefined;
      const results = await stub.searchNotes({
        query: args.query,
        dateFrom: Number.isNaN(dateFrom) ? undefined : dateFrom,
        dateTo: Number.isNaN(dateTo) ? undefined : dateTo,
        dateField: args.date_field || "created",
        limit: args.limit || 10,
      });
      const matches = results.map((n) => ({
        id: n.id,
        title: n.title,
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
