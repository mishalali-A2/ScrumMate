import fs from "fs";

// Load workflow JSON from file
const workflowJson = JSON.parse(fs.readFileSync("ScrumMate UserStory Backlogging.json", "utf8"));

// 1. Import workflow into n8n
const createRes = await fetch("http://localhost:5678/rest/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workflowJson),
});
const workflow = await createRes.json();

console.log("Imported workflow with ID:", workflow.id);

// 2. Execute workflow
const runRes = await fetch(`http://localhost:5678/rest/workflows/${workflow.id}/run`, {
    method: "POST",
});
const result = await runRes.json();

console.log("Execution result:");
console.log(JSON.stringify(result, null, 2));
