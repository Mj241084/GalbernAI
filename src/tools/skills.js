// Skill NAME + DESCRIPTION are always listed in the system prompt (tier 1,
// cheap). The full instructional body is only pulled into context when you
// actually need it (tier 2), via this tool - keeping unrelated skills from
// bloating every single request.

export const definitions = [
  {
    type: "function",
    function: {
      name: "view_skill",
      description: "Load the full instructions of a skill by name, when its description matches what you're doing.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
];

export async function execute(name, args, { stub }) {
  if (name !== "view_skill") throw new Error(`unknown skills tool: ${name}`);
  const skill = await stub.getSkillBody(args.name);
  return { ok: true, name: skill.name, body: skill.body };
}
