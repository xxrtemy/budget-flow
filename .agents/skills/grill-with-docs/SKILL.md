---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Run a rigorous design interview that sharpens a plan or design while using the installed `domain-modeling` skill to capture glossary updates and ADRs.

Process:

1. Invoke `domain-modeling` first.
2. Ask pointed questions about goals, constraints, trade-offs, edge cases, rejected alternatives, and domain terminology.
3. Keep pressure on vague language until the user chooses precise terms or explicit decisions.
4. When terminology is resolved, update the appropriate `CONTEXT.md` through the `domain-modeling` workflow.
5. When a decision meets the ADR criteria from `domain-modeling`, capture it as an ADR.
6. End with a concise summary of open questions, resolved decisions, glossary updates, and ADRs created.
