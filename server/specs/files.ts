/**
 * The files: reading, writing, searching and keeping them tools.
 *
 * These were entries in one 81-entry array in server/tools.ts. Nothing about
 * them changed in the move -- each is the same spec, in the same order, and the
 * registry below lists them in the order they were listed before.
 */

import type { ToolSpec } from "../tools";
import { PDF_FILE, PDF_OUTPUT, PDF_PASSWORD } from "./shared";

export const filesSPECS: ToolSpec[] = [
  {
    name: "artifact_save",
    group: "files",
    description:
      "Save a file you made as an artifact, so the person can find, open and " +
      "download it on the Artifacts page long after this conversation. Use it " +
      "for deliverables -- a report, a document, a spreadsheet, a script, an " +
      "export -- not for scratch output. Give either `content` (the text of " +
      "the file) or `path` (a file on this host, e.g. one you built with the " +
      "terminal). Images from image_generate are saved automatically. Save " +
      "only what is net new or has changed. Do not save a copy of a file that " +
      "is already in the workspace or already on the Artifacts page, and do " +
      "not save a picture you downloaded or found online -- it can be fetched " +
      "again from its own address and the thread already shows it. Check " +
      "artifact_list first when you are unsure. Saving a name that is already " +
      "there replaces that artifact's contents in place, so save again only " +
      "when the file itself is different. If the person asks you to keep " +
      "something, save it.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "File name with extension, e.g. q3-report.md or data.csv.",
        },
        content: { type: "string", description: "The file's text." },
        path: { type: "string", description: "Absolute path of a file on this host to save instead." },
        note: { type: "string", description: "One line on what it is." },
        notebook: {
          type: "string",
          description: "A notebook (id or title) to file it in as well. A title no notebook has makes a new one.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "artifact_list",
    group: "files",
    description:
      "List the artifacts in the workspace: files the person uploaded for you " +
      "(documents, photos, spreadsheets) and files you made earlier. When the " +
      "person mentions something they uploaded, look here first.",
    parameters: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          enum: ["all", "user", "agent"],
          description: "user = uploaded by the person, agent = made by you. Default all.",
        },
      },
    },
  },
  {
    name: "artifact_read",
    group: "files",
    description:
      "Read an artifact by id. Text files come back as text (use offset and " +
      "length for long ones); images are shown in the conversation; for a PDF, " +
      "use pdf_read and pdf_look instead; anything else is reported with the " +
      "path on this host, so the terminal can open it.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The artifact id, e.g. file_0123456789abcdef." },
        offset: { type: "number", description: "Character to start from. Defaults to 0." },
        length: { type: "number", description: "How many characters to return." },
      },
      required: ["id"],
    },
  },
  {
    name: "notebook",
    group: "files",
    description:
      "Notebooks group artifacts by purpose, with notes between them, on the person's Notebooks page. " +
      "Use one for any report, case or dossier built from several sources: file every source (email, " +
      "document, screenshot) as an entry with a line on what it shows, and write findings, rebuttals and " +
      "summaries as notes that cite the files they rest on. Actions: list; create (title, purpose); " +
      "read (the whole notebook, every entry with its id -- read it before saying a notebook is done, " +
      "and check every source is in it and every claim cites one); add (artifacts, or a note with " +
      "title/text/cites; position to insert); edit (entry and title/text/cites, or no entry to change " +
      "the notebook's title/purpose); remove (entry; the file stays an artifact); move (entry, position); " +
      "export (the whole notebook as one Markdown artifact, files as numbered exhibits).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "read", "add", "edit", "remove", "move", "export"],
        },
        notebook: { type: "string", description: "The notebook's id (nb_...) or its title." },
        title: { type: "string", description: "create: the notebook's title. add/edit: a note's heading or a file's caption." },
        purpose: { type: "string", description: "create/edit: what the notebook is for." },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "add: artifact ids (file_...) or names to file, each as its own entry. text becomes their annotation.",
        },
        text: { type: "string", description: "add/edit: a note's body, or a file's annotation, in Markdown." },
        cites: {
          type: "array",
          items: { type: "string" },
          description: "add/edit: artifact ids or names the note's claims rest on.",
        },
        entry: { type: "string", description: "edit/remove/move: the entry id (en_...), from read." },
        position: { type: "number", description: "add/move: where, counting from 1. Default the end." },
        offset: { type: "number", description: "read: character to start from, for a notebook too long to read at once." },
      },
      required: ["action"],
    },
  },

  {
    name: "pdf_read",
    group: "files",
    description:
      "Read a PDF: its pages and their sizes, its properties, its form fields (name, kind, value, choices, " +
      "and where each one is), its attachments and XFA, and its text page by page. Give find to search it " +
      "instead: each match comes back with its page and box. Positions in all the PDF tools are points " +
      "(1/72 inch) from the top-left corner of the page as it is shown, so what pdf_read reports, pdf_look's " +
      "grid shows and pdf_edit takes all line up. extract saves embedded files (the XML inside an e-invoice, " +
      "say) or an XFA form's XML as artifacts, to read with artifact_read.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        pages: {
          type: "string",
          description: "Which pages' text: \"1-3,7\", \"5-\", \"last\". Default all, as far as fits; the result says how to read on.",
        },
        find: {
          type: "array",
          items: { type: "string" },
          description: "Search instead of reading: plain text (any case), a /regular expression/, or email, phone, ssn, credit_card, date.",
        },
        extract: {
          type: "array",
          items: { type: "string" },
          description: "Embedded files to save as artifacts, by name, or \"all\"; \"xfa\" saves an XFA form's XML.",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_look",
    group: "files",
    description:
      "See a PDF's pages as pictures: in this result, and in the conversation for the person. Use it to read " +
      "a scan, to see where things are before putting something on a page, and to check your own edits " +
      "before saying they are done. grid rules the page, labelled in points from its top-left corner -- the " +
      "coordinates pdf_edit takes. area zooms into part of one page. XFA forms (the kind most viewers only say " +
      "\"please wait\" to) are drawn too.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        pages: { type: "string", description: "Which pages, at most 4 at a time: \"1\", \"2-3\", \"last\". Default 1." },
        grid: { type: "boolean", description: "Rule the page with labelled lines, for reading off positions." },
        area: {
          type: "object",
          description: "Part of the (first) page to look at closely, in points from its top-left.",
          properties: {
            x: { type: "number" }, y: { type: "number" },
            width: { type: "number" }, height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_edit",
    group: "files",
    description:
      "Change a PDF, saving the result as a new artifact shown in the conversation (the person's own file is " +
      "never overwritten; your own earlier result is updated in place). In one call, in this order: fill form " +
      "fields, flatten the form, draw items on pages, add a watermark, number the pages, set or strip the " +
      "document's properties. Items: text, stamp (APPROVED, REJECTED, SIGN_HERE, INITIAL_HERE, DATE, " +
      "CONFIDENTIAL, COPY, or any short word), signature (a picture of one, or a typed name in a handwriting " +
      "font), image, check, cross, rect, ellipse, line, arrow, curve (a line that bends through a control point), path (any SVG path: curves, waves, loops), highlight (a box, or every match of some " +
      "text) and note (a comment). Positions are points from the top-left of the page as shown -- read them " +
      "off pdf_read, or pdf_look with grid. Drawing over something hides it but does not remove it: pdf_redact " +
      "takes text out, and pdf_replace_text changes the words a file already has. The file opens in the PDF window beside the conversation, where what you add stays an " +
      "object the person can move, change or remove, and they can add their own; edit the same file again to " +
      "carry on with it. Everything you add, change or remove is marked in the window for the person to accept or " +
      "decline one by one (a declined change is undone and you are told), and each state of the file is kept as a " +
      "version they can go back to. Look at the pages you changed with pdf_look before saying it is done.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        fields: {
          type: "object",
          additionalProperties: true,
          description:
            "Form fields to fill, by the names pdf_read lists: text for a text field, true or false for a " +
            "checkbox, the option for a radio group or dropdown, a list for a multi-select list.",
        },
        flatten: { type: "boolean", description: "Make the form part of the page, so its values can no longer be changed." },
        add: {
          type: "array",
          description: "Things to draw on pages, in order.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["text", "stamp", "signature", "image", "check", "cross", "rect", "ellipse", "line", "arrow", "curve", "path", "highlight", "note"],
              },
              page: { type: "string", description: "Page number, or pages like \"1-3\" or \"all\" to put it on each. Default 1." },
              x: { type: "number", description: "Left edge, in points from the page's left." },
              y: { type: "number", description: "Top edge, in points from the page's top." },
              width: { type: "number", description: "Width in points. Text wraps at it; a picture keeps its shape when only one side is given." },
              height: { type: "number", description: "Height in points." },
              x2: { type: "number", description: "Where a line or arrow ends." },
              y2: { type: "number", description: "Where a line or arrow ends." },
              cx: { type: "number", description: "For curve: the control point the line bends toward (x), in points from the page's left." },
              cy: { type: "number", description: "For curve: the control point (y), in points from the page's top." },
              cx2: { type: "number", description: "For curve: a second control point (x), for an S-bend. Give cy2 with it." },
              cy2: { type: "number", description: "For curve: the second control point (y)." },
              text: {
                type: "string",
                description: "The words: of a text item or note, a typed signature, a stamp's own label, or the text to highlight wherever it is on the page.",
              },
              stamp: {
                type: "string",
                description: "APPROVED, REJECTED, SIGN_HERE, INITIAL_HERE, DATE (today's date), CONFIDENTIAL, COPY, or any short word.",
              },
              image: { type: "string", description: "A picture, as an artifact id or a path: the signature or image to place." },
              field: { type: "string", description: "A form field's name: put the signature or picture in that field's box, instead of at x and y." },
              size: { type: "number", description: "Font size for text (default 12); the box for check and cross (default 14)." },
              color: { type: "string", description: "Ink or outline: a name (black, red, blue, ink...) or #rrggbb; none for no outline." },
              fill: { type: "string", description: "Fill colour for rect, ellipse and path." },
              background: { type: "string", description: "A colour behind text, e.g. white to cover what was there." },
              font: { type: "string", enum: ["helvetica", "times", "courier"] },
              bold: { type: "boolean" },
              italic: { type: "boolean" },
              align: { type: "string", enum: ["left", "center", "right"], description: "Within width." },
              thickness: { type: "number", description: "Line width in points." },
              opacity: { type: "number", description: "0 to 1." },
              d: { type: "string", description: "For path: an SVG path in points from x, y, with any commands (M L H V C S Q T A Z, upper or lower case): curves, loops, waves, arcs. E.g. \"M 0 40 C 30 0, 90 80, 120 40\"." },
            },
            required: ["type"],
          },
        },
        change: {
          type: "array",
          description:
            "Objects already on the pages to alter, by id (from the results of earlier pdf_edit calls): each is " +
            "{id, ...} with only the fields that differ, using the same fields as add items.",
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: true },
        },
        remove: { type: "array", items: { type: "string" }, description: "Ids of objects on the pages to take off." },
        watermark: {
          type: "object",
          description: "Big faint text across pages, e.g. {\"text\": \"DRAFT\"}.",
          properties: {
            text: { type: "string" },
            pages: { type: "string", description: "Default all." },
            color: { type: "string" },
            opacity: { type: "number", description: "Default 0.2." },
            size: { type: "number", description: "Default: as big as fits." },
            rotation: { type: "number", description: "Degrees, counter-clockwise. Default 45." },
          },
          required: ["text"],
        },
        page_numbers: {
          type: "object",
          description: "Number the pages, e.g. {\"format\": \"Page {n} of {total}\"}.",
          properties: {
            format: { type: "string", description: "With {n} and optionally {total}. Default \"Page {n} of {total}\"." },
            position: {
              type: "string",
              enum: ["bottom-center", "bottom-left", "bottom-right", "top-center", "top-left", "top-right"],
            },
            pages: { type: "string", description: "Which pages carry a number, e.g. \"2-\" to skip a cover. Default all." },
            start: { type: "number", description: "The first number shown. Default 1." },
            size: { type: "number" },
            color: { type: "string" },
          },
        },
        metadata: {
          type: "object",
          description: "Document properties to set.",
          properties: {
            title: { type: "string" }, author: { type: "string" }, subject: { type: "string" },
            keywords: { type: "string" }, creator: { type: "string" }, producer: { type: "string" },
          },
        },
        strip_metadata: { type: "boolean", description: "Remove all its document properties (title, author, dates, software, XMP) first." },
        output: PDF_OUTPUT,
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_compose",
    group: "files",
    description:
      "Write a new PDF -- a report, brief, summary, comparison -- from a description of the document, and keep it " +
      "as that description so you can carry on with it. You give headings, paragraphs, lists, tables, quotes, " +
      "code and pictures; the wrapping, page breaks, page numbers and a numbered list of sources are done for you, " +
      "so there are no coordinates to work out. Use this, not pdf_edit, to produce a document with words in it; " +
      "pdf_edit is for marking up a file that exists (stamps, signatures, notes, form fields). The result is shown " +
      "in the PDF window beside the conversation, where pdf_edit's objects can go on top of it and the person can " +
      "add their own. When you find something new, do not start over: send update (change a block by id), insert " +
      "(new blocks after a given block) or remove, and the whole document is laid out again with the same ids. The " +
      "result tells you which heading is on which page and the id of every block. Cite as you go: give a block " +
      "its source (a URL or a note) and it is marked [n] and listed under Sources at the end. In text, **bold**, " +
      "*italic*, `code` and [words](https://link) work; a blank line starts a new paragraph. The built-in fonts " +
      "cover Western European letters only. Look at the pages with pdf_look before saying it is done.",
    parameters: {
      type: "object",
      properties: {
        blocks: {
          type: "array",
          description:
            "The whole document, in order (replaces what there was). Each block has a type and, optionally, an id " +
            "(one is made up otherwise) and a source. Types: heading {text, level 1-3}; paragraph {text}; " +
            "bullets {items: [text or {text, source}], ordered}; table {header: [..], rows: [[..]], widths: [relative " +
            "numbers], align: [left|right|center per column], caption}; quote {text}; code {text}; image {image: " +
            "artifact id or path of a PNG/JPEG, width in points, caption}; rule; page_break.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Names the block for update, insert and remove." },
              type: { type: "string", description: "heading, paragraph, bullets, table, quote, code, image, rule or page_break." },
              text: { type: "string" },
              level: { type: "number", description: "For a heading: 1 (largest) to 3." },
              items: { type: "array", items: {} },
              ordered: { type: "boolean" },
              header: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
              widths: { type: "array", items: { type: "number" } },
              align: { type: "array", items: { type: "string" } },
              image: { type: "string" },
              width: { type: "number" },
              caption: { type: "string" },
              source: {
                description: "Where this came from: a URL or a note (or a list of them). Cited as [n] and listed at the end.",
                anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              },
            },
            required: ["type"],
          },
        },
        update: {
          type: "array",
          description: "Changes to blocks of the document already made: each {id, ...the fields to change}. The type may change too.",
          items: { type: "object", additionalProperties: true },
        },
        insert: {
          type: "array",
          description: "New blocks to put in: each {after: a block id, or \"start\" or \"end\", blocks: [...]}.",
          items: { type: "object", additionalProperties: true },
        },
        remove: { type: "array", items: { type: "string" }, description: "Ids of blocks to take out." },
        title: { type: "string", description: "The title at the top of the first page, and the file's title." },
        subtitle: { type: "string" },
        author: { type: "string" },
        date: { type: "string", description: "Shown beside the author, e.g. \"1 Oct 2026\"." },
        paper: { type: "string", description: "a4 (default) or letter." },
        landscape: { type: "boolean" },
        font: { type: "string", description: "helvetica (default, sans-serif) or times (serif)." },
        size: { type: "number", description: "Body text size in points, 8 to 16 (default 11)." },
        margin: { type: "number", description: "Page margin in points (default 56)." },
        page_numbers: {
          description: "A format with {n} and {total} (default \"Page {n} of {total}\"), or false for none.",
          anyOf: [{ type: "string" }, { type: "boolean" }],
        },
        sources_heading: {
          description: "The title of the list of sources at the end (default \"Sources\"), or false to leave the list out.",
          anyOf: [{ type: "string" }, { type: "boolean" }],
        },
        output: PDF_OUTPUT,
      },
    },
  },
  {
    name: "pdf_pages",
    group: "files",
    description:
      "Rearrange a PDF's pages, saving the result as a new artifact shown in the conversation: keep some, " +
      "drop some, change their order, repeat one, add blank pages, turn pages, add the pages of other PDFs " +
      "after them (merge), or split the result into several files. Page numbers are this file's own, before " +
      "any change. Dropped pages are taken out of the file, not hidden.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        pages: {
          type: "string",
          description:
            "The pages of the result, in order, by number: \"3,1,2\" reorders, \"1-4,6-\" drops page 5, " +
            "\"1,1,2-\" repeats page 1, \"1,blank,2-\" puts a blank page after page 1, \"last-1\" reverses. " +
            "Default all, as they are.",
        },
        rotate: {
          type: "array",
          description: "Turn pages clockwise, e.g. [{\"pages\": \"2\", \"degrees\": 90}].",
          items: {
            type: "object",
            properties: {
              pages: { type: "string", description: "Default all." },
              degrees: { type: "number", description: "90, 180 or 270." },
            },
            required: ["degrees"],
          },
        },
        merge: {
          type: "array",
          items: { type: "string" },
          description: "Other PDFs (artifact ids or paths) whose pages go after these, in order.",
        },
        split: {
          type: "array",
          items: { type: "string" },
          description: "Make several files instead of one, each from pages of the result: [\"1-3\", \"4-\"], or [\"each\"] for one file per page.",
        },
        output: PDF_OUTPUT,
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_replace_text",
    group: "files",
    description:
      "Change words that are already in a PDF -- a name, an amount, a date, a typo -- and save the result as a new " +
      "artifact shown in the conversation. This edits the file's own text: where the page's font can write the new " +
      "words they are rewritten in place, in the same typeface, and stay selectable and searchable; where it cannot " +
      "(a letter the file's cut-down font never drew) the old words are taken out of the file and the new ones drawn in " +
      "a built-in font of the same kind, colour and size. Either way the old words are gone from the bytes, and the " +
      "rest of the page stays vector. Use this, not pdf_edit, to change what a page says: pdf_edit only draws on top, " +
      "and covering words with a white box leaves them in the file. It does not work on a scan (a picture of text has " +
      "no words); pdf_read find shows whether the words are text. find must be the words as pdf_read shows them. " +
      "Words are not reflowed: if the new words are longer or shorter, text the file places separately on the same line stays put. " +
      "Give every change in one call. Look at the result with pdf_look before saying it is done.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        replace: {
          type: "array",
          description: "The changes, each made wherever its words appear.",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "The words as they are now. Spacing between words does not matter." },
              with: { type: "string", description: "What they become. Empty to delete them." },
              ignore_case: { type: "boolean", description: "Match any capitalisation. Default exact." },
            },
            required: ["find", "with"],
          },
        },
        pages: { type: "string", description: "Which pages: \"1-3,7\", \"last\". Default all." },
        output: PDF_OUTPUT,
      },
      required: ["file", "replace"],
    },
  },
  {
    name: "pdf_redact",
    group: "files",
    description:
      "Take text or areas out of a PDF for good, saving the result as a new artifact shown in the " +
      "conversation. Each page with something to remove is redrawn as a picture with black boxes over it, so " +
      "what was under them is gone from the file rather than covered; pages with nothing to remove keep their " +
      "text. find takes plain text, /regular expressions/ and the presets email, phone, ssn, credit_card and " +
      "date; areas take boxes, read off pdf_look with grid. It says what it removed where. Check the result " +
      "with pdf_look.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        find: {
          type: "array",
          items: { type: "string" },
          description: "What to remove wherever it appears: plain text (any case), a /regular expression/, or email, phone, ssn, credit_card, date.",
        },
        areas: {
          type: "array",
          description: "Boxes to remove, in points from the page's top-left.",
          items: {
            type: "object",
            properties: {
              page: { type: "string", description: "A page, or pages like \"all\". Default 1." },
              x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" },
            },
            required: ["x", "y", "width", "height"],
          },
        },
        pages: { type: "string", description: "Only search these pages. Default all." },
        dpi: { type: "number", description: "How sharp the redrawn pages are. Default 150." },
        output: PDF_OUTPUT,
      },
      required: ["file"],
    },
  },
  {
    name: "pdf_compress",
    group: "files",
    description:
      "Make a PDF smaller, saving it as a new artifact shown in the conversation. lossless (the default) " +
      "rewrites it compactly and drops anything unused, changing nothing you can see. images redraws every " +
      "page as a JPEG -- far smaller for scans and picture-heavy files, but the text can no longer be selected " +
      "or searched, and links and form fields are gone; it also turns an XFA form into an ordinary PDF of how " +
      "it looks. Nothing is saved if it does not get smaller.",
    parameters: {
      type: "object",
      properties: {
        file: PDF_FILE,
        password: PDF_PASSWORD,
        mode: { type: "string", enum: ["lossless", "images"] },
        dpi: { type: "number", description: "For images: resolution. Default 110." },
        quality: { type: "number", description: "For images: JPEG quality, 0.1 to 1. Default 0.7." },
        output: PDF_OUTPUT,
      },
      required: ["file"],
    },
  },

  // ---------------------------------------------------------------- Office --
  {
    name: "office_guide",
    group: "files",
    description:
      "How to edit a document (.docx), spreadsheet (.xlsx) or presentation (.pptx) file: the operations office_edit takes, with their fields and examples. " +
      "Read it BEFORE your first office_edit or office_create of a kind -- the operation names are exact and a wrong one is " +
      "rejected. domain is docs (Autora Pages, .docx), sheets (Autora Sheets, .xlsx) or slides (Autora Slides, .pptx). With no topic it lists the operation groups; " +
      "topic is one group (e.g. text, insert, table) or one operation by name (e.g. setText); for slides, topic design or " +
      "spec describes building a new deck.",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "docs, sheets or slides." },
        topic: { type: "string", description: "An operation group or one operation; omit to list the groups." },
      },
      required: ["domain"],
    },
  },
  {
    name: "office_read",
    group: "files",
    description:
      "Read a document (.docx, Autora Pages), spreadsheet (.xlsx, Autora Sheets) or presentation (.pptx, Autora Slides) file. Pages (.docx): its blocks, each with the [index] edits target; " +
      "range \"0-20\" for part of it; include comments, revisions, styles, header-footer, sections, fields or notes for those. " +
      "Sheets (.xlsx): the cells of a sheet and range (values, with each formula alongside), the sheet's features; stats gives counts " +
      "and the sheet list. Slides (.pptx): every slide's elements with their durable ids (s_1, e_...), positions in EMU (914400 " +
      "to the inch), text and effective font; slide for one slide, full for whole text and speaker notes, layouts for the " +
      "deck's layouts. This reads the file as saved; it cannot show you a page or a slide as a picture.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The document: an artifact id (file_...), a path on this host, or an artifact's name." },
        range: { type: "string", description: "Pages (.docx): block range like \"0-20\". Sheets (.xlsx): cell range like \"A1:D20\"." },
        sheet: { type: "string", description: "Sheets (.xlsx): the worksheet (default: the active one)." },
        slide: { type: "number", description: "Slides (.pptx): only this 0-based slide." },
        full: { type: "boolean", description: "Whole text instead of previews (Pages blocks, slide text, tables, notes)." },
        include: {
          type: "array",
          items: { type: "string" },
          description: "Pages extras: comments, revisions, styles, header-footer, sections, fields, notes.",
        },
        formats: { type: "boolean", description: "Sheets (.xlsx): also return cell formats, column widths and row heights." },
        stats: { type: "boolean", description: "Sheets (.xlsx): counts, used range and the sheet list instead of cells." },
        where: { type: "string", description: "Sheets (.xlsx): only cells of one kind: formula, error, empty, number or text." },
        layouts: { type: "boolean", description: "Slides (.pptx): also list the deck's layouts." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_edit",
    group: "files",
    description:
      "Change a document (.docx), spreadsheet (.xlsx) or presentation (.pptx) file with operations (call office_guide for the exact names and fields first). " +
      "Only what you edit is rewritten; the rest of the file survives byte for byte. The result is saved as a new artifact " +
      "beside the original (your own earlier result is updated in place). ops is the array of operations, targeted by the ids " +
      "office_read shows (Pages (.docx): block [index]; Slides (.pptx): s_/e_ ids; Sheets (.xlsx): cell addresses). Excel also takes cells: " +
      "[{cell:\"B2\", value|formula, sheet?, style?}] for plain cell edits -- formulas are recalculated, and the results are " +
      "in the file. Pages (.docx): track:true records edits as tracked changes the person can accept or reject. dry_run validates and " +
      "reports each step without writing; best_effort applies every operation that can and lists the ones that cannot. " +
      "Check the result with office_check.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The document: an artifact id, a path, or an artifact's name." },
        ops: { type: "array", items: { type: "object" }, description: "The operations, in order. See office_guide." },
        cells: { type: "array", items: { type: "object" }, description: "Sheets (.xlsx): [{cell, value|formula, sheet?, style?}]." },
        track: { type: "boolean", description: "Pages (.docx): record the edits as tracked changes." },
        author: { type: "string", description: "Pages with track: the author shown on the changes." },
        dry_run: { type: "boolean", description: "Validate and report without writing." },
        best_effort: { type: "boolean", description: "Apply what can be applied and list what cannot." },
        output: { type: "string", description: "File name for the result. Default: the original's name with -edited added." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_check",
    group: "files",
    description:
      "Look a document (.docx), spreadsheet (.xlsx) or presentation (.pptx) file over for problems, in place of seeing it. Slides (.pptx): text that overflows its " +
      "box, elements off the slide or overlapping, distorted pictures, each with a ready setTransform fix. Sheets (.xlsx): formula " +
      "errors, references to sheets that are not there, broken names, chart ranges off the data, columns too narrow to show " +
      "their numbers (###), placeholder text. Pages (.docx): fields with no result, broken bookmark references, a stale table of " +
      "contents, missing images, heading levels that skip, placeholder text, pending tracked changes, open comments. Run it " +
      "after you build or change a document, and fix what it reports before you say it is done.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The document: an artifact id, a path, or an artifact's name." },
        slide: { type: "number", description: "Slides (.pptx): only this 0-based slide." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_open",
    group: "files",
    description:
      "Open a document (.docx), presentation (.pptx) or spreadsheet (.xlsx) file in the window beside the conversation, in its own editor, so the person can " +
      "read it and change it while you work. A file you make or change with the Office tools opens there by itself; this is " +
      "for one that already exists (an upload, an earlier file). What they change is saved as they go and you are told what.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The file: an artifact id, a path, or an artifact's name." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_look",
    group: "files",
    description:
      "See a document (.docx), presentation (.pptx) or spreadsheet (.xlsx) file's pages as they lay out: pictures of its pages (a deck's slides, a workbook's " +
      "printed sheets), drawn by the same editor a person would use, shown in the conversation and handed to you. pages is " +
      "a list like \"1\", \"1-3\" or \"2,4\" (a few at a time); area {x,y,width,height} in points from the page's " +
      "top-left looks closer at part of one page, and grid draws a ruler. Use it after you build or change a file, to check " +
      "it looks right; office_check still finds what looking would not (overflow, broken formulas). A deck or workbook " +
      "takes ten seconds or so to draw. A workbook draws only its active sheet: read the others with office_read. " +
      "(Sheets also: set_freeze wants rows and columns, 0 for none; add_chart wants one contiguous range with typed numbers, not only formulas.)",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The file: an artifact id, a path, or an artifact's name." },
        pages: { type: "string", description: "Which pages: \"1\", \"1-3\", \"2,4\". Default 1." },
        area: {
          type: "object",
          description: "Look closer at one part of one page, in points from its top-left.",
          properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        },
        grid: { type: "boolean", description: "Draw a ruler in points over the picture." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_pdf",
    group: "files",
    description:
      "Turn a document (.docx), presentation (.pptx) or spreadsheet (.xlsx) file into a PDF, laid out by its own editor (a deck one slide per page, a workbook as printed). The PDF is saved as an artifact and opens " +
      "in the PDF editor, where it can be marked up, signed, redacted or sent on (the PDF tools work on it from there).",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The file: an artifact id, a path, or an artifact's name." },
        output: { type: "string", description: "File name for the PDF. Default: the document's name with .pdf." },
      },
      required: ["file"],
    },
  },
  {
    name: "office_create",
    group: "files",
    description:
      "Make a new document (.docx), spreadsheet (.xlsx) or presentation (.pptx) file, saved as an artifact. docx: markdown (headings, lists, tables, bold/italic, " +
      "links) or restricted html. xlsx: rows -- a 2-D array of cells where a string starting with = is a formula, or " +
      "{sheets:[{name, rows}]} for several sheets -- or csv text (header:true to treat the first row as a header). pptx: " +
      "spec, the deck as {pages:[...]} (a 1280x720 px canvas of shapes, text, pictures, tables and charts; call " +
      "office_guide slides design and spec first), or ops for the editing operations. Refine it afterwards with office_edit, " +
      "and check it with office_check.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "docx, xlsx or pptx." },
        name: { type: "string", description: "File name for the result (the extension is added)." },
        markdown: { type: "string", description: "docx: the content as Markdown." },
        html: { type: "string", description: "docx: the content as restricted HTML." },
        rows: { description: "xlsx: a 2-D array, or {sheets:[{name, rows}]}." },
        csv: { type: "string", description: "xlsx: the content as CSV text." },
        header: { type: "boolean", description: "xlsx csv: the first row is a header." },
        spec: { description: "pptx: the deck, {pages:[...]}." },
        ops: { type: "array", items: { type: "object" }, description: "pptx: operations that build the deck." },
      },
      required: ["type"],
    },
  },
  {
    name: "office_convert",
    group: "files",
    description:
      "Convert between formats that need no page layout: .docx to .md or .html; .md to .docx or .html; .html to .docx; " +
      ".csv to .xlsx; .xlsx to .csv (sheet names the worksheet). The result is saved as an artifact. PDF is not here: " +
      "the PDF tools handle PDFs.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "The document: an artifact id, a path, or an artifact's name." },
        to: { type: "string", description: "docx, md, html, csv or xlsx." },
        sheet: { type: "string", description: "xlsx to csv: the worksheet (default: the active one)." },
        output: { type: "string", description: "File name for the result." },
      },
      required: ["file", "to"],
    },
  },

  // --------------------------------------------------------------- memory --
];
