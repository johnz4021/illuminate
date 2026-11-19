// A question about a walkthrough step starts by naming the step, so Claude knows it and the page shows it as a chip
// under the question. The page writes this for its own question box (`viewer/src/step.ts`, which also reads it back);
// this is the same wording for a question asked in the agent's chat while a step is on screen. Keep the two the same
// (a server test compares them).
export const askAboutStep = (step: string, question: string): string => `About the walkthrough step “${step}”: ${question}`;
