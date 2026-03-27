# TOON Format

`memory.ts` outputs data in **TOON**, a compact YAML-like syntax designed to save LLM tokens. It is highly readable, but if you need standard JSON for scripting or parsing, you can decode it.

## Decode TOON to JSON

```bash
echo "<toon_string>" | bunx --bun @toon-format/cli --decode
```

## Example

**TOON:**

```toon
id: abc123
tags:
  - important
```

**JSON Equivalent:**

```json
{
  "id": "abc123",
  "tags": ["important"]
}
```
