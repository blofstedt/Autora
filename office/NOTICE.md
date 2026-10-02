# Third-party notice: GenOffice

Autora's Word, Excel and PowerPoint tools run the document engines of
[GenOffice](https://github.com/genspark-ai/genoffice), which is
Copyright 2026 Mainfunc, Inc. and licensed under the Apache License 2.0.

Nothing from GenOffice is copied into this repository. `scripts/build-office.mjs`
fetches the commit named in `office/PIN.json`, builds its command line and its
spreadsheet engine unchanged, and places the results in `dist/office/` together
with GenOffice's `LICENSE` and `NOTICE`. The `ee/` directory of that repository
is under a separate, non-Apache licence and is neither used nor built.
