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
   - Read `${CLAUDE_SKILL_DIR}/references/show-me.md` for the visual-outline conventions used in the description.

2. Write the description to fit the change:
   - Start with why the change exists, in one sentence: the problem it solves and what is true once it ships. It stands alone as a paragraph.
   - Size it to the change. A reviewer reads the description before the diff, and stops reading once it stops helping. A change that needs a line gets a line. A small change (a few files, a hundred lines or so) gets its opening sentence and one to three points: why, and the one thing to look at first, if there is one. A large or subtle one earns more: what not to miss, a view of its shape, what was turned down. Leave out what the diff shows plainly (each file touched, each test added, a setting's exact value) and what only says the process happened. Cut a detail rather than a reason, and when in doubt, cut.
   - Note what a reviewer should not miss, in 1-3 bullets, when there is anything: warnings, migrations, compatibility constraints, deliberate omissions, or surprising decisions. Leave it out when there is nothing.
   - Make it easy to scan, not dense. After the opening sentence, points go in a bulleted list, one point to a bullet, each a sentence or two, with a few words in bold to lead when that helps a reviewer find their place; a paragraph of prose is for an argument that needs its steps in order, and is short. Leave blank lines between parts.
   - When the shape of the change helps explain it, add a compact, `/show-me`-inspired structural view rather than prose or a file-by-file changelog. Include only the views that help explain this change:
     - SQL table and endpoint contract changes, plus pseudocode for business logic.
     - key data structure / type changes
     - A shallow file tree showing changed responsibilities.
     - React component tree changes, including important hooks, state, and package boundaries.
     - Call-tree, call-stack, control-flow, or data-flow changes.
   - Prefer `diff` blocks when showing changes to an existing shape. Show the complete target shape when most of it is new or diff notation would obscure ownership or order.
   - Keep each view focused on what a reviewer needs, with a short sentence before it saying what it shows.
   - Tell the story in the order that makes it easiest to understand. Use headings only when the description is long enough to need them, and name them for this change, never from a fixed template.
   - Fold what supports the story (how it was tested, how it rolls out, the decisions behind it) into sections of their own, when there is anything to say: a `<details>` whose `<summary>` holds a `##` heading, so it reads as a heading that folds. Which sections a change needs is yours to judge. Their names are the one exception to naming headings for the change: name each plainly for what it holds, and as the repository's recent descriptions name the same thing when you can see them, so a reviewer finds Tests or Rollout where they found it last time.
   - Open a section with `<details open>` when a reviewer needs it before judging the change, and leave it closed when they would read it only to check. A section on files the repository's CODEOWNERS gives an owner is always open: the owner reads it first.
   - Leave the blank lines a folded section needs. A line that starts with `<details>`, `<summary>` or either's closing tag starts an HTML block, which only a blank line ends, and Markdown inside it is shown as text: so one after `<summary>`, one before `</summary>`, one after it, and one before and after `</details>`. A description whose folded sections would not render is refused.

     ```markdown
     <details>
     <summary>

     ## Tests

     </summary>

     - The body: lists, code, tables and diagrams render as they do anywhere.

     </details>
     ```

3. Save the description:
   - Write it, as Markdown, to the file the step names. It is the description's whole text: no title, and nothing about how it was written.
   - Do not open, edit or push a pull request, or commit anything: the step publishes the description.

Write as one human talking to another: avoid jargon and slang, and use simple, coherent, concise language.
