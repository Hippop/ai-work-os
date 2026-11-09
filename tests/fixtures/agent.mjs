import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const workspace = args[args.indexOf("-C") + 1];
const result = args[args.indexOf("-o") + 1];
const prompt = args.at(-1);
if (
  process.env.AI_WORK_OS_FIXTURE_HANG === "1" ||
  (process.env.AI_WORK_OS_FIXTURE_HANG === "implement" &&
    prompt.includes("Step: implement."))
)
  setInterval(() => {}, 1000);
else {
  if (prompt.includes("Step: conclude.")) {
    writeFileSync(
      result,
      JSON.stringify({
        summary: "Evidence is insufficient",
        hypotheses: [
          {
            claim: "Insufficient evidence for a verified root cause",
            supportingEvidence: [],
            contradictingEvidence: [],
            nextExperiment: "Collect controlled reproduction evidence",
            status: "open",
          },
        ],
        conclusion: {
          status: "unresolved",
          hypothesisIndex: null,
          reason: "No verified causal experiment is available",
          unknowns: ["Need verified experiment"],
        },
      }),
    );
    console.log(JSON.stringify({ type: "turn.completed" }));
    process.exit(0);
  }
  if (prompt.includes("Step: implement."))
    writeFileSync(
      join(workspace, "answer.txt"),
      prompt.includes("FAIL_BASELINE") && !prompt.includes("执行改进候选")
        ? "41"
        : "42",
    );
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
