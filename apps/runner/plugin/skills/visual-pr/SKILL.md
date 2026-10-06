---
name: visual-pr
description: Only use when the user explicitly invokes this skill by name.
---

# Describe a Pull Request

Write the description of a pull request: one that helps a reviewer understand why the change exists and the shape of the implementation, at the length the change needs.

## Workflow

1. Gather only the context needed to explain the change:
   - Read what the step gives you: the ticket, the spec, the review and anything else it names.
   - Read the complete diff (`git diff base`), the commit messages (`git log base..HEAD`), and enough surrounding code to understand behavior and ownership.
   - If the repository has a pull request template, read it as it is at the base (`git show base:.github/pull_request_template.md`). Its sections are the questions a reviewer there expects answered: answer the ones this change raises, in the description's own shape. They are guidance, not headings to fill.
   - Read `{SKILLBASE}/references/show-me.md` for the visual-outline conventions used in the description.

2. Write the description to fit the change:
   - Start with why the change exists, in one sentence: the problem it solves and what is true once it ships.
   - A change that needs a line gets a line. Add more only where a reviewer needs it to judge the change.
   - Note what a reviewer should not miss, in 1-3 bullets, when there is anything: warnings, migrations, compatibility constraints, deliberate omissions, or surprising decisions. Leave it out when there is nothing.
   - When the shape of the change helps explain it, add a compact, `/show-me`-inspired structural view rather than prose or a file-by-file changelog. Include only the views that help explain this change:
     - SQL table and endpoint contract changes, plus pseudocode for business logic.
     - key data structure / type changes
     - A shallow file tree showing changed responsibilities.
     - React component tree changes, including important hooks, state, and package boundaries.
     - Call-tree, call-stack, control-flow, or data-flow changes.
   - Prefer `diff` blocks when showing changes to an existing shape. Show the complete target shape when most of it is new or diff notation would obscure ownership or order.
   - Keep each view focused on what a reviewer needs, with a short sentence before it saying what it shows.
   - Tell the story in the order that makes it easiest to understand. Use headings only when the description is long enough to need them, and name them for this change, never from a fixed template.

3. Save the description:
   - Write it, as Markdown, to the file the step names. It is the description's whole text: no title, and nothing about how it was written.
   - Do not open, edit or push a pull request, or commit anything: the step publishes the description.

Write as one human talking to another: avoid jargon and slang, and use simple, coherent, concise language.
