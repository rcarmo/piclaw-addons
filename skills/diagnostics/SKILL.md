---
name: diagnostics
description: Validate code files for syntax, lint, and type errors. Extensible via .pi/validators.json.
distribution: public
---

# Diagnostics

Run the `diagnostics` tool to validate files. Call without args to list available validators.

## Usage

```
diagnostics({})                          # list validators
diagnostics({ file: "path/to/file.ts" }) # validate a file
```

## Notes

- Multiple validators may run per file type — results are combined
- Exit code 0 + no output = valid
- Custom validators defined in `/workspace/.pi/validators.json`
- `/restart` after editing validators.json
