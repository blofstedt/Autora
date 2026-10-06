/**
 * Pieces of tool schema shared by more than one group's specs.
 *
 * These were declared at the top of server/tools.ts, next to the array the
 * specs lived in. Now that the specs are one file per group, what two groups
 * share cannot sit inside either of them.
 */

export const PDF_FILE = {
  type: "string",
  description: "The PDF: an artifact id (file_...), a path on this host, or an artifact's name.",
};
export const PDF_PASSWORD = {
  type: "string",
  description: "Its password, if it is password-protected. What the tools save has none.",
};
export const PDF_OUTPUT = {
  type: "string",
  description:
    "File name for the result. Default: the original's name with -edited, -redacted... added, " +
    "or your own earlier result, updated.",
};
