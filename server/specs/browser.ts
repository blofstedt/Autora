/**
 * The live browser tools.
 *
 * These were entries in one 81-entry array in server/tools.ts. Nothing about
 * them changed in the move -- each is the same spec, in the same order, and the
 * registry below lists them in the order they were listed before.
 */

import type { ToolSpec } from "../tools";

export const browserSPECS: ToolSpec[] = [
  {
    name: "browser_open",
    group: "browser",
    description:
      "Open a web page in the live browser the person watches, and return its " +
      "main content as text (a part at a time on long pages) with the numbered " +
      "elements that are on screen. This is how to look at or use any website: " +
      "reading an article, checking a product, signing in, filling a form. For " +
      "finding pages use web_search first; for APIs that answer in JSON use " +
      "http_request.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The address to open." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_read",
    group: "browser",
    description:
      "Re-read the page that is currently open: the numbered elements on screen " +
      "(with what each field is for, what it holds, its choices and any error " +
      "the page shows on it), where the page is scrolled to, and a part of its " +
      "main text. Long pages come in parts; ask for the next one with `part` to " +
      "read further. Scrolling is only needed to reach elements, never to read text.",
    parameters: {
      type: "object",
      properties: {
        part: {
          type: "integer",
          description: "Which part of the page's text to return, from 1. Default 1.",
        },
      },
    },
  },
  {
    name: "browser_click",
    group: "browser",
    description:
      "Click one of the numbered elements on the open page, then return the " +
      "page as it is afterwards (after any navigation it started has loaded). " +
      "An element keeps its number while the page stays the same, however far " +
      "it is scrolled, and one that is off screen is scrolled into view first. " +
      "If something is drawn over the element (a cookie bar, a pop-up) the click " +
      "is held back and the result says what covers it and how to dismiss it. " +
      "If the page did not change, the result says so. " +
      "After the page changes, use the numbers from the latest result. To " +
      "choose from a dropdown or tick a checkbox, browser_fill is surer.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "integer",
          description: "The element number, as listed in the page outline.",
        },
      },
      required: ["ref"],
    },
    risky: true,
  },
  {
    name: "browser_fill",
    group: "browser",
    description:
      "Fill one or more numbered fields on the open page in one go, optionally " +
      "submitting the form afterwards, then return the resulting page with what " +
      "each field now holds. Works for every kind of field: text is typed into " +
      "boxes; a dropdown (combobox with options) gets the option whose text " +
      "matches; a checkbox or switch is ticked for \"yes\" and cleared for " +
      "\"no\"; a radio button is selected; a date field takes the date in any " +
      "clear form (2031-04-05 is safest). Match each value to what the field " +
      "is for -- its (purpose), type, section and hint -- not only its label: " +
      "\"Name\" marked (first name) takes the first name alone. Read the " +
      "result: a field that reformatted, refused or shows INVALID needs fixing " +
      "before you submit. The person's saved details and sign-ins go in as " +
      "placeholders such as {{cred:first_name}} or {{cred:github.com:password}}; " +
      "the value is typed in for you and you never see it.",
    parameters: {
      type: "object",
      properties: {
        values: {
          type: "array",
          description: "The fields to fill and what to put in each.",
          items: {
            type: "object",
            properties: {
              ref: { type: "integer", description: "The field's element number." },
              text: {
                type: "string",
                description: "What to put in it: the text, the dropdown option's text, yes/no for a checkbox, or a date.",
              },
            },
            required: ["ref", "text"],
          },
        },
        submit: {
          type: "boolean",
          description: "Submit the form when done (Enter in the last text field). Default false.",
        },
      },
      required: ["values"],
    },
    risky: true,
  },
  {
    name: "browser_upload",
    group: "browser",
    description:
      "Attach files from the Artifacts to an upload field on the open page -- " +
      "a CV on a job application, a photo, a document a form asks for. Give " +
      "the field's number, or the number of the button that opens the file " +
      "picker (\"Upload CV\", \"Attach\", \"Choose file\"), or the " +
      "drag-and-drop box itself (\"Drop your CV here\") -- a box with no file " +
      "input gets the files dropped onto it -- and the " +
      "artifact ids (see artifact_list). The files go in as if chosen in the " +
      "picker. Returns the page afterwards: check the site shows the file " +
      "attached before submitting.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "integer",
          description: "The upload field's element number, or the button that opens its file picker.",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Artifact ids of the files to attach, e.g. [\"file_0123456789abcdef\"]. Usually one.",
        },
      },
      required: ["ref", "ids"],
    },
    risky: true,
  },
  {
    name: "browser_scroll",
    group: "browser",
    description:
      "Scroll to bring other elements on screen, and return what is there " +
      "afterwards and where that left you (how far down, how much is left, or " +
      "that nothing moved because you are already at the end). Scrolls " +
      "whatever actually scrolls -- the page, or the pane that does on app-like " +
      "sites. Give `text` to jump straight to where some text is (asking again " +
      "moves on to the next place it appears), `ref` to scroll inside that " +
      "element (a list, a side panel, a dialog), `to` for the top or bottom, " +
      "or `screens` to move by screenfuls. Not needed for reading: browser_read " +
      "returns the text in parts.",
    parameters: {
      type: "object",
      properties: {
        screens: {
          type: "number",
          description: "How far, in screens: 1 is down one screen, -1 up one. Default 1.",
        },
        to: { type: "string", enum: ["top", "bottom"], description: "Go straight to the top or the bottom." },
        text: { type: "string", description: "Scroll to where this text appears on the page." },
        ref: {
          type: "integer",
          description: "Scroll inside this element (or its scrolling container) rather than the page; alone, just bring it into view.",
        },
      },
    },
  },
  {
    name: "browser_press",
    group: "browser",
    description:
      "Press keys on the open page, as at a keyboard: Escape to close a " +
      "dialog or menu, Enter to submit or pick, Tab to move to the next " +
      "field, ArrowDown/ArrowUp to walk a suggestion list (then Enter to " +
      "choose), PageDown, Backspace, or a combination such as Control+A. " +
      "Give `ref` to focus that element first. Returns the page afterwards.",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Keys in order, e.g. [\"ArrowDown\", \"Enter\"]. Names as Playwright spells them: Enter, Escape, Tab, ArrowDown, PageDown, Backspace, Control+A.",
        },
        ref: { type: "integer", description: "Focus this element before pressing." },
      },
      required: ["keys"],
    },
    risky: true,
  },
  {
    name: "browser_signin_import",
    group: "browser",
    description:
      "Sign the browser in to a site with the person's own sign-in, brought " +
      "over as a cookie export they uploaded. Use this when a site refuses to " +
      "let this browser sign in (\"This browser or app may not be secure\", " +
      "\"browser not supported\", a sign-in that keeps bouncing): ask the " +
      "person to sign in to that site in their own browser, export its " +
      "cookies (the Cookie-Editor extension: open it on the site, Export, " +
      "JSON), and upload the file here; then call this with the file's " +
      "artifact id. The sign-in lasts until the site expires it. The uploaded " +
      "file is deleted after a successful import, since it is a live key to " +
      "the account.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The uploaded cookie file's artifact id (see artifact_list)." },
        keep_file: {
          type: "boolean",
          description: "Keep the uploaded file instead of deleting it after import. Default false.",
        },
      },
      required: ["id"],
    },
    risky: true,
  },
  {
    name: "browser_back",
    group: "browser",
    description: "Go back one entry in the open page's history.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_devtools",
    group: "browser",
    description:
      "What DevTools shows for the open tab: its console (log, info, warn, error and uncaught errors) or the " +
      "network requests it made (method, status, type, time, size, and the ones that failed). Use it to find " +
      "out why a page is blank or a button does nothing. `errors_only` keeps just the errors and failed or " +
      "4xx/5xx requests.",
    parameters: {
      type: "object",
      properties: {
        panel: { type: "string", enum: ["console", "network"] },
        errors_only: { type: "boolean" },
        limit: { type: "integer", description: "Newest entries to return (default 40)." },
      },
      required: ["panel"],
    },
  },
  {
    name: "browser_tabs",
    group: "browser",
    description:
      "The browser's tabs. action 'list' names them (id, address, title; the one you are working in is " +
      "marked); 'new' opens a tab (with `url`, loads it); 'switch' makes tab `id` the one browser_read, " +
      "browser_click and the rest act on; 'close' closes tab `id`. A link that opens a new tab switches " +
      "to it on its own. Use this to keep a page open while you look at another.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "switch", "close"] },
        id: { type: "integer", description: "Tab number, for switch and close." },
        url: { type: "string", description: "Address to open, for new." },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_screenshot",
    group: "browser",
    description:
      "Take a picture of the open page. You get it back in the result, so this " +
      "is how to see a page rather than read it: use it when asked what " +
      "something looks like, when a page is stuck or half drawn, or when " +
      "something is on it that its text does not mention. The person sees it " +
      "too, on the browser screen. It is the last picture kept: an earlier one " +
      "is dropped when a new one arrives. To keep a screenshot -- as evidence, " +
      "for a report, because the person asked for one -- give save_as (and " +
      "notebook to file it there); full_page, selector or area choose what is in it.",
    parameters: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "The whole page, scrolled top to bottom, not just the window." },
        ref: { type: "number", description: "Only this numbered element, from the page's element list." },
        selector: { type: "string", description: "Only this element, by CSS selector (e.g. main, #invoice, table.results)." },
        area: {
          type: "object",
          description: "Only this rectangle of the window, in pixels from its top-left.",
          properties: {
            x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
          },
        },
        save_as: { type: "string", description: "Keep it as an artifact with this file name (.png is added)." },
        notebook: { type: "string", description: "Also file it in this notebook (id or title; a new title makes one)." },
        note: { type: "string", description: "With save_as: one line on what it shows -- its annotation in the notebook." },
      },
    },
  },
  {
    name: "browser_eval",
    group: "browser",
    description:
      "Run JavaScript in the open page, and get back what it returned with the page " +
      "as it is afterwards. This is how to reach what the numbered outline cannot " +
      "see: a dialog drawn by script (no refs anywhere), a control with no label, a " +
      "value that lives only in the DOM, or a list too long to read. Use it when a " +
      "read comes back unchanged, when a click by number does nothing, or when two " +
      "reads have told you the same thing twice. `script` is the whole script: an " +
      "expression (`document.title`), or statements with a return (`const b = " +
      "__autora.all(\"button\"); return b.length;`). The page has helpers: " +
      "__autora.byText(\"Save as draft\") finds the element that says those words " +
      "(also matching aria-label, title and placeholder), __autora.all(css) lists " +
      "elements, __autora.el(css) is one, and __autora.click(anything) really clicks " +
      "it - the click is drawn on the person's screen and reported back with what it " +
      "hit. A click that finds nothing says so rather than clicking the wrong thing. " +
      "Scripts are given 8 seconds. Everything the script does is real: it can " +
      "change the page, so click once and read the result.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "The JavaScript to run in the page. E.g. " +
            "__autora.click(__autora.byText(\"Save as draft\")) to click a button no " +
            "outline lists, or __autora.all(\"button\").map((b) => b.innerText) to see " +
            "what the buttons on the page say.",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "browser_captcha",
    group: "browser",
    description:
      "Tick a checkbox CAPTCHA on the open page -- reCAPTCHA's \"I'm not a robot\", " +
      "hCaptcha, or Cloudflare Turnstile -- using humanlike mouse movement (curved path, " +
      "varying speed, off-centre landing, natural press timing). These checkboxes sit in " +
      "iframes and never appear in the numbered outline, so use this instead of " +
      "browser_click. It also finds one the page draws itself, with no widget frame at " +
      "all -- a look-alike box that says it is a checkbox. When there is a picture " +
      "challenge to answer -- a grid of images to pick from, or a piece to drag -- this " +
      "answers that too, whether the widget draws it or the page does, using the " +
      "backends set in Settings, and reports which one did it. Call it again for a " +
      "challenge that is still there; hand the browser to the person with browser_handoff " +
      "only when it says it has given up.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_handoff",
    group: "browser",
    description:
      "Hand the live browser to the person watching and wait for them. Call this when you " +
      "reach a sign-in (OAuth/SSO, a password, a 2FA code), a CAPTCHA that browser_captcha " +
      "could not pass, or anything on the page only they should do. Not for a site that " +
      "refuses this browser's sign-in outright -- they will be refused too; use " +
      "browser_signin_import for that. They get a card " +
      "explaining what is needed and can then tap and type directly in the page. This " +
      "call returns when they say they are done (with the page as it is then) or that " +
      "they cannot do it. For a CAPTCHA it also returns by itself the moment the page " +
      "shows it passed, so never ask the person whether they have finished one.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Explanation of what human action is needed (e.g. 'Please log in to GitHub via OAuth' or 'Please complete the Cloudflare verification').",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "http_request",
    group: "browser",
    description:
      "Make an HTTP API call directly from the server. Supports GET, POST, PUT, PATCH, DELETE, HEAD " +
      "with custom headers and body. For APIs and data files, not for looking at websites: use " +
      "browser_open for those, which the person can watch. A web page fetched here comes back as " +
      "its readable text, not its HTML. If calling api.github.com, automatically attaches the " +
      "GITHUB_TOKEN from the workspace secret store so you never need to ask the user for passwords. " +
      "The person's saved details and sign-ins go in as placeholders -- {{cred:first_name}}, " +
      "{{cred:github.com:password}} -- in the url, in any header value or in the body; the real " +
      "value is substituted for you and never appears in the transcript. A sign-in is only " +
      "substituted into a request to a site it belongs to.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full target URL." },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          description: "HTTP method (default GET).",
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers as key-value pairs.",
        },
        body: {
          type: "string",
          description: "Optional request body string or JSON.",
        },
      },
      required: ["url"],
    },
    risky: true,
  },
  {
    name: "web_search",
    group: "browser",
    description:
      "Search the web for up-to-date documentation, release notes, news, code examples, or factual answers " +
      "without being blocked by search engine bot detection. Then open the result you need with " +
      "browser_open.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query terms." },
      },
      required: ["query"],
    },
  },
  {
    name: "image_generate",
    group: "browser",
    description:
      "Generate an image from a detailed descriptive prompt using Gemini Imagen and show it in the conversation thread.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate.",
        },
      },
      required: ["prompt"],
    },
    risky: true,
  },

  // ----------------------------------------------------------- computer --
];
