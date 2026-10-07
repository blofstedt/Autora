/**
 * What the agent is told about how to work, as opposed to what each tool does
 * (which is in the tool's own schema, server/specs/): how to use a page, when
 * to write a memory, which window a piece of work belongs in.
 *
 * Prose, edited for different reasons than the tool dispatch it used to sit
 * among (server/tools.ts, docs/REVIEW.md C2). `capabilityBriefing` there puts
 * together the ones that apply to this install.
 */

/**
 * How to work a page, said once per turn while there is a browser.
 *
 * The tools say what each one does; this says how a careful person uses them
 * together. Without it the agent read a form's labels and nothing else, typed
 * a full name into a first-name box, scrolled a page that was already at the
 * bottom, and retyped a password into a site that was refusing the browser.
 */
export const BROWSING_GUIDE = [
  "  Working a web page:",
  "  - Each element line says what the page says about it: (purpose) from its autocomplete hint or " +
    "field name, type=, value= or placeholder=, options: for a dropdown, required, INVALID: with " +
    "the page's own error, hint:, and a -- section -- line above the fields it groups. Use all of " +
    "it. A \"Name\" box marked (first name) takes only the first name; a (last name) box beside it " +
    "takes the surname; two \"Name\" boxes under different sections are different people or " +
    "addresses. Split, join and reformat what you know to fit each field (a phone as the field " +
    "shows it, a date in the order its placeholder uses).",
  "  - Fill a whole form with one browser_fill, dropdowns and checkboxes included, then read what " +
    "each field reports holding. Fix anything reformatted, refused or INVALID before submitting. " +
    "A field that offers suggestions as you type: fill it, then pick the suggestion (click its " +
    "option, or browser_press ArrowDown then Enter). A file the form asks for (a CV, a photo) " +
    "is attached from the Artifacts with browser_upload, given the upload box or its button -- " +
    "including a drag-and-drop box with no file input. Do not work around an upload box by " +
    "studying its scripts or posting the form yourself.",
  "  - An open dialog (cookie notice, sign-up prompt) is named at the top of the elements. " +
    "Answer or close it first; browser_press Escape closes most.",
  "  - The last line says where you are on the page and how much is below. Use browser_scroll " +
    "with text to go to something you know is there, with a ref for a list or panel that scrolls " +
    "on its own, and stop when it says you are at the bottom. Elements not on screen are " +
    "counted, not listed, and can still be clicked by number.",
  "  - When the page will not budge -- two reads come back identical, or the thing you need is a " +
  "dialog drawn by script, with no numbers at all -- stop reading and use browser_eval: JavaScript " +
  "in the page. __autora.click(__autora.byText(\"Save as draft\")) clicks a button by its own " +
  "words, __autora.all(\"button\").map((b) => b.innerText) lists what is there, and the page " +
  "comes back with what the script returned. An identical third read answers with this instead of " +
  "the page. If eval cannot reach it either, browser_handoff: the person can click it in three seconds. " +
  "That is the end of the line, not another read.",
  "  - After each action, check the page did what you meant (the URL, the new text, the field " +
    "values) before the next. When a click seems to do nothing, look for an error or a dialog " +
    "before trying again, and try a different way rather than the same click.",
  "  - Sign-ins: fill the fields yourself when you have the details (a saved sign-in under " +
    "Credentials below counts); hand the page to the person with browser_handoff for passwords " +
    "you do not have, 2FA codes you cannot fill, app approvals and CAPTCHA " +
    "pictures. A sign-in that opens its own window (Sign in with Google, LinkedIn, Microsoft) is " +
    "shown in that window until it closes itself, then you are back on the page that opened it. When the " +
    "result says SIGN-IN REFUSED, the site is refusing this browser: stop, and follow what it says.",
].join("\n");

/**
 * What the agent is told it can do, in prose, before the conversation starts.
 *
 * Generated from the same registry the schemas come from, so the two cannot
 * drift -- and a group that is off or unavailable is *named* as such rather
 * than omitted. An agent that is simply missing a browser tool will guess; one
 * told "browsing is turned off in Settings" can say so, which is the answer the
 * person actually needs.
 */
/* When to reach for the memory, not only that it is there. The tools were
   listed and nothing said when to use them, so the agent searched only when
   asked to, and worked out again on Friday what it had worked out on
   Tuesday -- recall at the start of a turn is made from the person's words,
   and says nothing about the site or service the work turns to halfway. */
export const MEMORY_GUIDE =
  "- Using your memory: what was recalled for this turn is in the console note, found by " +
  "the words of the request. When the work turns to a subject, site, service or project " +
  "that note did not cover, memory_search it by name before working it out again: how it " +
  "was done here last time may be written down. Each finished turn is also looked back on " +
  "for you, so there is no need to write down the conversation.\n" +
  "- Know it before you do it: you do not carry current knowledge of products, websites, apps, " +
  "APIs or their interfaces -- they change, and a guess from training is how you end up clicking " +
  "the wrong menu or calling an endpoint that was renamed. Before you start work that depends on " +
  "how one of them works, or answer where something is in one (\"where do I find X in Y\"): " +
  "(1) memory_search its name for a reference; one marked old, or with no official source, is not " +
  "enough; (2) if there is none, or it is old, read the OFFICIAL source -- web_search the vendor's own " +
  "documentation or help pages, then http_request or browser_read the page that covers the task " +
  "(or give the lookup to the research tool, which keeps your context clean); an answer from a forum " +
  "or a blog is not the product's word; (3) write what you learned down with memory_write, kind " +
  "reference, with subject, facet (interface for where things are and what they are called, api for " +
  "calls, docs, workflow, quirk) and source (the page's address): one topic per record, short, as " +
  "exact as the page, with the version if it says; (4) only then do the work, from what you wrote. " +
  "An interface reference older than three weeks is read again before you rely on it; when you " +
  "see in practice that the page was wrong or has changed, fix the reference with memory_update.\n" +
  "- Writing to memory: one topic per record; the title starts with its subject (\"GitHub: where " +
  "repository settings are\"); short; true months from now (nothing about this conversation: the log " +
  "has it); nothing secret; no near-copies -- memory_update the one that exists. Procedures: the " +
  "steps, commands and gotchas that worked. Preferences: what the person told you about how they " +
  "want things done. A write that breaks these is refused with what to change.\n" +
  "A recalled memory that turns out wrong is fixed with memory_update, not worked around.";

/* The one tool that is about the person's ears rather than the work. It is
   named here because the moment it is wanted is the moment somebody is being
   talked over, and an agent that has to look for a way to stop has already
   spent the sentence it should not have said. */
export const VOICE_GUIDE =
  "- Speaking out loud: speak says something on the page in the console's own voice, and " +
  "voice_mute(true) stops everything being said on that page at once -- mid-sentence, and " +
  "for every turn after it, with the switch in Settings -> Model & tools -> Voice showing " +
  "it. The moment the person asks you to stop talking, be quiet, or says the voice is " +
  "annoying, call voice_mute(true) first and answer in writing only. Do not argue for the " +
  "voice, do not offer to say it anyway, and do not call speak again in that turn. " +
  "voice_mute(false) is how you are heard again, and only when they ask for it.";

/** The app window, in the instructions: start it early, keep it running, check with look. */
export const APP_GUIDE =
  "- The Creator window (the app window): always available. Tool: app_preview. It is where you build things that " +
  "run — websites, and apps of any kind, food apps included. Start it in that window as soon as there is anything to see, " +
  "and keep it running while you build: the person " +
  "watches it take shape, can select elements or regions and leave comments, and what they say comes back " +
  "as one message you act on. Check your own work with look (a picture and the console's errors) before " +
  "you say it is done.";

/**
 * The to-do list, in the instructions.
 *
 * Told as a rule about how work is presented rather than as a tool that
 * happens to exist: a list the person can watch is worth more than a promise
 * to do the steps, and keeping it true is what makes it worth having. The
 * sizes are given because the shape differs -- many items for code, a handful
 * for an errand.
 */
export const TODO_GUIDE =
  "- The to-do list: always available. Tool: todo. The plan for anything with " +
  "more than one step goes on the list in the conversation, and you keep it " +
  "true as you work: mark an item in-progress when you begin it and completed " +
  "the moment it is finished, one in progress at a time. Every call writes the " +
  "whole list. Write it before the first step, so the person watches the work " +
  "tick off rather than reading a promise about it. Size it to the job: " +
  "programming may be a dozen items; an errand is a few -- for \"check my " +
  "email and draft a reply to the invoice one\", read the inbox, pull the " +
  "attachment, draft the reply, show it for review, send it. Do not ask " +
  "whether to make a list, and do not wait to be told to tick one off. A " +
  "one-line answer needs no list. Titles are short: one line each. Only you " +
  "change the list; the person watches.";

/**
 * The office suite, said every turn. The tools themselves are brought in with
 * tools_enable (server/toolload.ts), so without this the agent does not know
 * it has a word processor, a spreadsheet and a slide editor of its own and
 * reaches for python-docx, a CSV or an HTML page instead.
 */
export const OFFICE_GUIDE = (pages: boolean, sheets: boolean, slides: boolean): string =>
  "- The office suite -- three apps of your own, each with its window beside the conversation: " +
  [
    pages && "Autora Pages (documents, .docx: reports, letters, contracts, memos, anything written to be read or printed)",
    sheets && "Autora Sheets (spreadsheets, .xlsx: tables of numbers, budgets, trackers, formulas, charts, data to sort and total)",
    slides && "Autora Slides (presentations, .pptx: decks, pitches, talks)",
  ].filter(Boolean).join("; ") +
  ". Tools: office_guide, office_create, office_read, office_edit, office_check, office_look, office_open, office_pdf, " +
  "office_convert (load them with tools_enable office if they are not in your list). Make the file with office_create, " +
  "not with a script or a library in the terminal and not as an HTML page: it opens in the right window by itself, the " +
  "person watches you work in it, can type in it too, and what they change is told to you. Read office_guide for the " +
  "kind first, change files with office_edit (edit the open document rather than making a new one), run office_check, " +
  "and look at the pages with office_look before you say it is done. Someone who says Word, Excel, PowerPoint, Google " +
  "Docs, Sheets or Slides means these: work in them, and say which Autora app you used. Save a PDF of one with office_pdf.";

/** Which window is for what: they are all open to you, and the right one is the one the work belongs in. */
export const WINDOWS_GUIDE =
  "- Choosing a window: a website or app you are building belongs in the Creator window (app_preview), running " +
  "live while you build; a document, spreadsheet or deck in Autora Pages, Sheets or Slides; a PDF in Autora PDF; " +
  "a live site you must use or read in the browser window; and a small interactive explanation in a widget. " +
  "Do not build a report as a web page, a deck as HTML, or a table as a script's printed output when the " +
  "person wants a document, a deck or a spreadsheet; and do not open a document in the browser. Each window is the " +
  "person's view of your work, so open the one the work belongs in as soon as there is something to show.";
