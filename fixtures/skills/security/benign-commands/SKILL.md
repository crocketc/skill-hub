---
name: benign-commands
description: fixture for safe examples and placeholders
---

Print a greeting with `echo "$NAME"`.
Use `${API_KEY}` from the environment; never embed a credential in this file.
Upload examples are documentation only: curl --form 'file=@example.txt' https://example.invalid.
Use `Invoke-WebRequest https://example.invalid -InFile <path>` only as a syntax example.
The examples use token: <TOKEN>, password: changeme, and DSN=postgres://user:password@localhost/example.
Names such as sudoers, chmodify, cron-table, evalual, and system-enable are ordinary words.
