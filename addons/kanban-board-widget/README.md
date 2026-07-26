# Kanban Board Page

A file-backed kanban page for work items stored under `workitems/`. Requires Piclaw `>=1.8.0`.

## Install

Open **Settings → Add-Ons** and install **kanban-board-widget** from the catalog, then reload Piclaw.

## Command and routes

The `/board` command reports the board URL. The add-on registers:

- `/board-page` — full interactive board
- `GET /api/board` — current lanes and tickets
- `POST /api/board/move` — move a ticket between lanes

The package does not register a `pi.web.entries` timeline renderer. Its main interface is the full browser page.

## Work-item layout

The board reads Markdown tickets from these directories:

`00-inbox`, `10-next`, `20-doing`, `30-blocked`, `40-review`, `50-done`.

Tickets use YAML frontmatter for fields such as ID, title, status, priority, estimate, risk, tags, dates, and quality. Moving a ticket renames the file into the target lane and updates `status` and `updated` frontmatter when those fields exist.

Ticket IDs are restricted to simple filename-safe slugs. The page supports drag-and-drop, filtering, detail views, local same-lane ordering, and light/dark themes.
