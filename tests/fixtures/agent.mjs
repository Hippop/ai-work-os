import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const workspace = args[args.indexOf("-C") + 1];
const result = args[args.indexOf("-o") + 1];
const prompt = args.at(-1);
if (process.env.AI_WORK_OS_FIXTURE_HANG === "1") setInterval(() => {}, 1000);
else {
  if (prompt.includes("Step: implement."))
    writeFileSync(join(workspace, "answer.txt"), "42");
  writeFileSync(
    result,
    JSON.stringify({
      summary: "Fixture stage completed",
      evidence: ["answer.txt"],
      risks: [],
    }),
  );
  console.log(JSON.stringify({ type: "turn.completed" }));
}
