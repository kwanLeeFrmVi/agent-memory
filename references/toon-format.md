# TOON Output Format

`memory.ts` outputs data in **TOON format** (compact YAML-like syntax) to save LLM tokens.

## Decode to JSON

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

**JSON:**

```json
{
  "id": "abc123",
  "tags": ["important"]
}
```
