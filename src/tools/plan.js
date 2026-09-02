// A "plan" is task decomposition for YOUR OWN execution of a complex,
// multi-step request - not a user-facing reminder. Only one can be active
// at a time; it can only be carried out (completed item by item), never
// edited or deleted. It is rendered into the system prompt automatically
// on every turn while active - you don't need a tool to "read" it back.

export const definitions = [
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Break a complex, multi-step request into an ordered plan you will execute yourself, item by item. Only use this for genuinely multi-step work - not simple requests. Only one plan can be active at a time; finish (complete every item of) the current one before starting another.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "One-line description of what the plan accomplishes." },
          items: {
            type: "array",
            items: { type: "string" },
            description: "Ordered list of concrete steps.",
          },
        },
        required: ["goal", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_plan_item",
      description:
        "Mark one item of the currently active plan as done, right after you actually finish that step. When the last item is completed the plan closes automatically and you become free to start a new one.",
      parameters: {
        type: "object",
        properties: { item_id: { type: "integer" } },
        required: ["item_id"],
      },
    },
  },
];

export async function execute(name, args, { stub }) {
  switch (name) {
    case "create_plan": {
      const result = await stub.createPlan({ goal: args.goal, items: args.items });
      return { ok: true, plan: result.plan, items: result.items };
    }
    case "complete_plan_item": {
      const result = await stub.completePlanItem(args.item_id);
      return { ok: true, ...result };
    }
    default:
      throw new Error(`unknown plan tool: ${name}`);
  }
}
