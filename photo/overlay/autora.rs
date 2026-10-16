//! Autora's side of the PhotoCraft window (copied into apps/photocraft-web/src/ by scripts/build-photo.mjs).
//!
//! PhotoCraft runs in a frame of Autora's page (components/PhotoWindow.tsx), and the two talk by postMessage only. All
//! of it is inert when the page is not framed, so the same build still works on its own.
//!
//! Page -> editor:
//!   { autoraPhoto: "load", name, bytes }   the working picture, as a .pcraft: it replaces what is open
//!   { autoraPhoto: "hand", json }          the agent's edit, done here by hand with Visible work on (see `hand_*` below):
//!                                          json is { id, commands: [{ id, params }], who: { name, color } }
//!
//! Editor -> page:
//!   { autoraPhoto: "ready" }               the editor is up and listening
//!   { autoraPhoto: "changed", name, bytes } the person changed the picture (a .pcraft, after a pause in their edits)
//!   { autoraPhoto: "file", name, bytes }   the person saved or exported a file (File > Save, Export): the page offers it
//!                                          as a download, since a frame cannot start one the way a page can
//!   { autoraPhoto: "handed", json, bytes } the agent's edit is done: json is { id, results }, bytes the picture after it
//!   { autoraPhoto: "cursor", x, y }        where the agent's cursor is, in the frame's CSS pixels (for its few words)
//!
//! The picture that is synced is the active document, so what the agent works on is what the person is looking at.

use std::cell::RefCell;
use std::time::Duration;

use js_sys::{ArrayBuffer, Object, Reflect, Uint8Array};
use photocraft_doc::DocId;
use photocraft_io::ExportOptions;
use photocraft_ui_egui::{Inbox, PhotocraftApp};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

const NS: &str = "autoraPhoto";
/// The name the synced picture goes under; the page keeps one working file per chat.
const WORK_NAME: &str = "work.pcraft";
/// How long the picture must sit unchanged before it is sent: a brush stroke is many revisions, one send.
const QUIET_MS: f64 = 700.0;

struct Pending {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Bridge {
    /// Loads that arrived and are not yet opened.
    loads: Vec<Pending>,
    /// The document and revision last sent, or that the page loaded: nothing to send until it moves on.
    sent: Option<(DocId, u64)>,
    /// The revision seen on the previous frame, and when it first showed.
    seen: Option<((DocId, u64), f64)>,
}

thread_local! {
    static SYNC: RefCell<Bridge> = RefCell::new(Bridge::default());
}

fn window() -> Option<web_sys::Window> {
    web_sys::window()
}

/// The page that frames this one, or None when this page stands alone.
fn parent() -> Option<web_sys::Window> {
    let me = window()?;
    let up = me.parent().ok().flatten()?;
    let (a, b): (&JsValue, &JsValue) = (up.as_ref(), me.as_ref());
    if a == b { None } else { Some(up) }
}

/// Whether Autora's page is around this one.
pub fn framed() -> bool {
    parent().is_some()
}

fn send(kind: &str, name: Option<&str>, bytes: Option<&[u8]>) -> Result<(), String> {
    let js = |e: JsValue| format!("{e:?}");
    let up = parent().ok_or("not framed")?;
    let origin = window().ok_or("no window")?.location().origin().map_err(js)?;
    let msg = Object::new();
    Reflect::set(&msg, &NS.into(), &kind.into()).map_err(js)?;
    if let Some(name) = name {
        Reflect::set(&msg, &"name".into(), &name.into()).map_err(js)?;
    }
    if let Some(bytes) = bytes {
        Reflect::set(&msg, &"bytes".into(), &Uint8Array::from(bytes).buffer()).map_err(js)?;
    }
    up.post_message(&msg, &origin).map_err(js)
}

/// A file the person saved or exported, handed to the page.
pub fn file(path: &str, bytes: &[u8]) -> Result<(), String> {
    let name = std::path::Path::new(path).file_name().map_or_else(|| path.to_owned(), |n| n.to_string_lossy().to_string());
    send("file", Some(&name), Some(bytes))
}

/// Listen for the page, and say the editor is up. Called once, when the app is made.
pub fn start(ctx: &egui::Context) {
    let (Some(me), true) = (window(), framed()) else { return };
    let ctx = ctx.clone();
    let on_message = Closure::<dyn FnMut(JsValue)>::new(move |ev: JsValue| {
        let Some(me) = window() else { return };
        // Only the page that frames this one, and only from its own origin.
        let origin = Reflect::get(&ev, &"origin".into()).ok().and_then(|v| v.as_string());
        let same = me.location().origin().ok();
        let source = Reflect::get(&ev, &"source".into()).ok();
        let from_parent = match (me.parent().ok().flatten(), source) {
            (Some(p), Some(s)) => AsRef::<JsValue>::as_ref(&p) == &s,
            _ => false,
        };
        if !from_parent || origin.is_none() || origin != same {
            return;
        }
        let Ok(data) = Reflect::get(&ev, &"data".into()) else { return };
        if !data.is_object() {
            return;
        }
        let kind = Reflect::get(&data, &NS.into()).ok().and_then(|v| v.as_string());
        if kind.as_deref() == Some("hand") {
            if let Some(json) = Reflect::get(&data, &"json".into()).ok().and_then(|v| v.as_string()) {
                hand_take(&json);
                ctx.request_repaint();
            }
            return;
        }
        if kind.as_deref() != Some("load") {
            return;
        }
        let name = Reflect::get(&data, &"name".into()).ok().and_then(|v| v.as_string()).unwrap_or_else(|| WORK_NAME.into());
        let Ok(buffer) = Reflect::get(&data, &"bytes".into()).and_then(|b| b.dyn_into::<ArrayBuffer>()) else { return };
        let bytes = Uint8Array::new(&buffer).to_vec();
        SYNC.with(|s| s.borrow_mut().loads.push(Pending { name, bytes }));
        ctx.request_repaint();
    });
    me.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).ok();
    on_message.forget();
    send("ready", None, None).ok();
}

/// Every frame, before the app runs: open what the page sent, in place of what is open.
pub fn pump(app: &mut PhotocraftApp, inbox: &Inbox) {
    if rail_on() {
        rail_pump(app);
        hand_pump(app);
    }
    let loads = SYNC.with(|s| std::mem::take(&mut s.borrow_mut().loads));
    // Only the newest matters: a quick run of agent edits is one picture.
    let Some(load) = loads.into_iter().last() else { return };
    while !app.session.documents().is_empty() {
        app.session.close(0);
    }
    inbox.lock().unwrap_or_else(|e| e.into_inner()).push((load.name, load.bytes));
    SYNC.with(|s| {
        let mut s = s.borrow_mut();
        s.sent = None;
        s.seen = None;
    });
}

/// Every frame, after the app ran: when the person's picture has changed and then held still, send it.
pub fn tick(app: &PhotocraftApp, ctx: &egui::Context) {
    if !framed() {
        return;
    }
    if rail_on() {
        rail_bar(app, ctx);
    }
    hand_draw(ctx);
    // The agent's hand is at work: what it changes goes back with its answer, not as the person's change.
    if hand_busy() {
        SYNC.with(|s| s.borrow_mut().seen = None);
        return;
    }
    let now = js_sys::Date::now();
    let Some(st) = app.session.active() else { return };
    let key = (st.doc.id, st.revision);
    let dirty = st.is_dirty();
    let due = SYNC.with(|s| {
        let mut s = s.borrow_mut();
        // Clean means as opened (or as the page sent it): nothing the person did.
        if !dirty || s.sent == Some(key) {
            s.seen = None;
            return false;
        }
        match s.seen {
            Some((seen, since)) if seen == key => now - since >= QUIET_MS,
            _ => {
                s.seen = Some((key, now));
                false
            }
        }
    });
    if !due {
        if dirty && SYNC.with(|s| s.borrow().sent != Some(key)) {
            ctx.request_repaint_after(Duration::from_millis(250));
        }
        return;
    }
    match photocraft_io::export(&st.doc, WORK_NAME, &ExportOptions::default()) {
        Ok(done) => {
            if send("changed", Some(WORK_NAME), Some(&done.bytes)).is_ok() {
                SYNC.with(|s| s.borrow_mut().sent = Some(key));
            }
        }
        Err(e) => log::error!("autora: could not keep the picture: {e}"),
    }
}

// ---- the tool bar ------------------------------------------------------------------------------------------------
//
// PhotoCraft is a Photoshop-sized editor: fifty-two tools, a hundred and fifty commands in nine menus, a dozen panels. In
// Autora's window (components/PhotoWindow.tsx) it wears the one tool bar every Autora app wears (docs/TOOL-RAIL.md): round,
// coloured tools down the right side of a desktop and along the bottom of a phone (`?phone=1`), as many as fit, and a last
// button that opens All tools: every tool, the panels the bar opens as sheets, and every live command of the menus, which
// are searched by name and each of which can be pinned to the bar on a desktop. The editor's own menu bar, toolbox,
// options bar, status bar and panel dock are away (the picture alone, `screen_mode = "fullScreen"`, forced each frame):
// nothing in them is a second copy of what is on the bar. Keyboard shortcuts are the editor's own and still work.
//
// The bar is drawn after the app each frame (`tick`, which can only look at the app) and what it asks for is queued; the
// next frame's `pump` (which has the app) does it, through the editor's own commands.

use photocraft_ui_egui::{icons, menus, Tool};

/// What a tap on the bar asks for.
enum Ask {
    Tool(Tool),
    Sheet(Option<Sheet>),
    /// One of the editor's own commands, with its parameters.
    Command(String, serde_json::Value),
    Brush { size: Option<f32>, opacity: Option<f32> },
    Colour([f32; 4]),
    Pin(String),
    ResetPins,
}

#[derive(Clone, Copy, PartialEq)]
enum Sheet {
    Brush,
    Layers,
    Colour,
}

#[derive(Default)]
struct Rail {
    phone: Option<bool>,
    asks: Vec<Ask>,
    sheet: Option<Sheet>,
    ctx: Option<egui::Context>,
    grid: bool,
    search: String,
    /// What a desktop's bar shows, in order (ids as `bar_id` writes them); None until the person pins or unpins.
    pins: Option<Vec<String>>,
    toast: Option<String>,
    /// Every tool, panel and command, made once and kept (`catalogue`): asking the editor for its menus checks each of
    /// its ~800 commands, far too much to do every frame. Made again when All tools opens and after a command ran.
    catalogue: Option<std::rc::Rc<Catalogue>>,
    /// Where the bar drew what the agent's hand may press, last frame (`hand_*`).
    spots: Spots,
}

/// Where things the agent's hand presses were drawn, in the editor's points.
#[derive(Default)]
struct Spots {
    grid_button: Option<egui::Rect>,
    search: Option<(egui::Rect, egui::Id)>,
    tiles: Vec<(String, egui::Rect)>,
    /// The visible part of All tools' list: a tile outside it is scrolled to first.
    list: Option<egui::Rect>,
}

thread_local! {
    static RAIL: RefCell<Rail> = RefCell::new(Rail::default());
}

/// The bar is the editor's whole interface when the window frames it.
fn rail_on() -> bool {
    framed()
}

/// Whether the page asked for the phone's arrangement (`?phone=1`): read once.
fn phone_on() -> bool {
    RAIL.with(|p| {
        let mut p = p.borrow_mut();
        *p.phone.get_or_insert_with(|| window().and_then(|w| w.location().search().ok()).is_some_and(|q| q.split(['?', '&']).any(|kv| kv == "phone=1")))
    })
}

const BLUE: egui::Color32 = egui::Color32::from_rgb(37, 99, 235);
const EMERALD: egui::Color32 = egui::Color32::from_rgb(5, 150, 105);
const AMBER: egui::Color32 = egui::Color32::from_rgb(245, 158, 11);
const PURPLE: egui::Color32 = egui::Color32::from_rgb(147, 51, 234);
const INDIGO: egui::Color32 = egui::Color32::from_rgb(79, 70, 229);
const SKY: egui::Color32 = egui::Color32::from_rgb(2, 132, 199);
const GOLD: egui::Color32 = egui::Color32::from_rgb(217, 119, 6);
const ROSE: egui::Color32 = egui::Color32::from_rgb(225, 29, 72);
const CYAN: egui::Color32 = egui::Color32::from_rgb(8, 145, 178);
const SLATE: egui::Color32 = egui::Color32::from_rgb(148, 163, 184);

/// The tools of the editor in groups, in the order a person reaches for them (the grid's sections).
const TOOL_GROUPS: [(&str, &[Tool]); 6] = [
    ("Move and crop", &[Tool::Move, Tool::Crop, Tool::Slice, Tool::SliceSelect]),
    ("Selection tools", &[Tool::RectMarquee, Tool::EllipseMarquee, Tool::Lasso, Tool::PolygonLasso, Tool::MagneticLasso, Tool::MagicWand, Tool::QuickSelection, Tool::ObjectSelection]),
    ("Paint", &[Tool::Brush, Tool::Pencil, Tool::MixerBrush, Tool::Eraser, Tool::BackgroundEraser, Tool::MagicEraser, Tool::Gradient, Tool::PaintBucket]),
    ("Retouch", &[Tool::SpotHealing, Tool::Healing, Tool::Patch, Tool::ContentAwareMove, Tool::RedEye, Tool::CloneStamp, Tool::PatternStamp, Tool::HistoryBrush, Tool::Blur, Tool::Sharpen, Tool::Smudge, Tool::Dodge, Tool::Burn, Tool::Sponge]),
    ("Type and shapes", &[Tool::Type, Tool::VerticalType, Tool::Pen, Tool::PathSelection, Tool::DirectSelection, Tool::Rectangle, Tool::EllipseShape, Tool::Triangle, Tool::Polygon, Tool::Line, Tool::CustomShape]),
    ("Look and measure", &[Tool::Eyedropper, Tool::Ruler, Tool::Note, Tool::Count, Tool::Hand, Tool::RotateView, Tool::Zoom]),
];

/// One colour per verb, the same ones every Autora app uses.
fn tool_colour(t: Tool) -> egui::Color32 {
    match t {
        Tool::Move | Tool::RectMarquee | Tool::EllipseMarquee | Tool::Lasso | Tool::PolygonLasso | Tool::MagneticLasso | Tool::MagicWand | Tool::QuickSelection | Tool::ObjectSelection => BLUE,
        Tool::Crop | Tool::Slice | Tool::SliceSelect | Tool::Rectangle | Tool::EllipseShape | Tool::Triangle | Tool::Polygon | Tool::Line | Tool::CustomShape => INDIGO,
        Tool::Brush | Tool::Pencil | Tool::MixerBrush | Tool::Pen | Tool::PathSelection | Tool::DirectSelection => PURPLE,
        Tool::Eraser | Tool::BackgroundEraser | Tool::MagicEraser => ROSE,
        Tool::Gradient | Tool::PaintBucket | Tool::Dodge | Tool::Burn | Tool::Sponge => AMBER,
        Tool::Type | Tool::VerticalType => EMERALD,
        Tool::Eyedropper | Tool::Ruler | Tool::Note | Tool::Count | Tool::Hand | Tool::RotateView | Tool::Zoom => CYAN,
        _ => SKY,
    }
}

fn menu_colour(top: &str) -> egui::Color32 {
    match top {
        "File" => GOLD,
        "Image" => AMBER,
        "Layer" => SKY,
        "Select" => BLUE,
        "Filter" => PURPLE,
        "View" => CYAN,
        "Type" => EMERALD,
        _ => SLATE,
    }
}

/// A bar item, whatever it is: how it looks and what it does.
#[derive(Clone)]
struct Item {
    id: String,
    label: String,
    icon: &'static str,
    color: egui::Color32,
    act: Act,
}

#[derive(Clone)]
enum Act {
    Tool(Tool),
    Sheet(Sheet),
    Command(String),
}

fn tool_item(t: Tool) -> Item {
    Item { id: format!("t:{t:?}"), label: t.label().trim_end_matches(" Tool").to_string(), icon: icons::tool_icon(t), color: tool_colour(t), act: Act::Tool(t) }
}

fn sheet_item(s: Sheet) -> Item {
    let (id, label, icon, color) = match s {
        Sheet::Layers => ("s:layers", "Layers", "layers", SKY),
        Sheet::Brush => ("s:brush", "Brush settings", "sliders-horizontal", PURPLE),
        Sheet::Colour => ("s:colour", "Colour", "palette", CYAN),
    };
    Item { id: id.into(), label: label.into(), icon, color, act: Act::Sheet(s) }
}

fn command_item(id: &str, label: &str, top: &str) -> Item {
    let icon = match id {
        "edit.undo" => "undo-2",
        "edit.redo" => "redo-2",
        "view.fitOnScreen" => "maximize-2",
        "file.save" | "file.saveAs" => "file",
        "file.new" => "file-plus",
        "file.open" => "folder-open",
        _ => "sparkles",
    };
    let color = if id.starts_with("edit.undo") || id.starts_with("edit.redo") { SLATE } else { menu_colour(top) };
    Item { id: format!("c:{id}"), label: label.trim_end_matches('…').to_string(), icon, color, act: Act::Command(id.to_string()) }
}

/// What the bar starts with: a phone's seven, a desktop's fourteen (a desktop pins from there).
fn default_ids(phone: bool) -> Vec<String> {
    let tools = if phone { vec![Tool::Move, Tool::RectMarquee, Tool::Crop, Tool::Brush, Tool::Eraser] } else { vec![Tool::Move, Tool::RectMarquee, Tool::Lasso, Tool::MagicWand, Tool::Crop, Tool::Brush, Tool::Eraser, Tool::PaintBucket, Tool::Type, Tool::Eyedropper] };
    let mut ids: Vec<String> = tools.into_iter().map(|t| tool_item(t).id).collect();
    ids.push(sheet_item(Sheet::Layers).id);
    if !phone {
        ids.push(sheet_item(Sheet::Colour).id);
    }
    ids.push("c:edit.undo".into());
    if !phone {
        ids.push("c:edit.redo".into());
    }
    ids
}

/// Before the app runs: do what the bar asked for, and keep the chrome the bar's.
fn rail_pump(app: &mut PhotocraftApp) {
    let (asks, ctx) = RAIL.with(|p| {
        let mut p = p.borrow_mut();
        (std::mem::take(&mut p.asks), p.ctx.clone())
    });
    for ask in asks {
        let Some(ctx) = ctx.as_ref() else { break };
        match ask {
            Ask::Command(id, params) => {
                RAIL.with(|p| {
                    let mut p = p.borrow_mut();
                    p.grid = false;
                    p.catalogue = None;
                });
                // The agent's hand pressed the tile of the command it is doing: it opens the command's dialog to set the
                // agent's values in it, as a person does; with nothing to set, the tile does what it does for anyone.
                match hand_pressed(&id) {
                    Some((label, true)) => {
                        photocraft_ui_egui::dialogs::open_command_dialog(app, &id, &label);
                    }
                    Some((_, false)) => hand_result(menus::invoke(app, ctx, &id, params)),
                    None => drop(menus::invoke(app, ctx, &id, params)),
                }
            }
            Ask::Tool(t) => {
                app.ui.tool = t;
                RAIL.with(|p| {
                    let mut p = p.borrow_mut();
                    p.sheet = None;
                    p.grid = false;
                });
            }
            Ask::Sheet(s) => RAIL.with(|p| {
                let mut p = p.borrow_mut();
                p.sheet = s;
                p.grid = false;
            }),
            Ask::Brush { size, opacity } => {
                if let Some(s) = size {
                    app.session.tools.brush.size = s;
                }
                if let Some(o) = opacity {
                    app.session.tools.brush.opacity = o;
                }
            }
            Ask::Colour(c) => app.session.tools.foreground = c,
            Ask::Pin(id) => RAIL.with(|p| {
                let mut p = p.borrow_mut();
                let mut pins = p.pins.take().unwrap_or_else(|| default_ids(false));
                if let Some(at) = pins.iter().position(|x| *x == id) {
                    pins.remove(at);
                } else {
                    pins.push(id);
                }
                p.pins = Some(pins);
            }),
            Ask::ResetPins => RAIL.with(|p| p.borrow_mut().pins = None),
        }
    }
    // The picture alone: everything else is on the bar, in a sheet, or in All tools.
    app.ui.view.screen_mode = "fullScreen".into();
}

fn painting(tool: Tool) -> bool {
    matches!(tool, Tool::Brush | Tool::Pencil | Tool::Eraser | Tool::PaintBucket | Tool::MixerBrush)
}

/// How many of the editor's points are one CSS pixel of the frame. Usually 1 (or the device's ratio); inside some
/// phone browsers the canvas is drawn at half the page's resolution and a point is two CSS pixels: sizes are asked for in CSS
/// pixels, so the bar is the same size to a thumb either way.
fn per_css_px(ctx: &egui::Context) -> f32 {
    let inner = window().and_then(|w| w.inner_width().ok()).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
    if inner > 1.0 { ctx.content_rect().width() / inner } else { 1.0 }
}

fn with_alpha(c: egui::Color32, a: u8) -> egui::Color32 {
    egui::Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

/// A round, coloured button: tinted when off, solid with a white glyph when on.
fn round(ui: &mut egui::Ui, icon: &str, color: egui::Color32, on: bool, enabled: bool, size: f32, tip: &str) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(size, size), if enabled { egui::Sense::click() } else { egui::Sense::hover() });
    let resp = resp.on_hover_text(tip);
    let (fill, ink) = if on {
        (color, egui::Color32::WHITE)
    } else {
        (with_alpha(color, if resp.hovered() && enabled { 72 } else { 41 }), color)
    };
    let (fill, ink) = if enabled { (fill, ink) } else { (with_alpha(color, 22), with_alpha(ink, 90)) };
    ui.painter().circle_filled(rect.center(), size / 2.0, fill);
    icons::paint(ui, rect, icon, size * 0.5, ink);
    resp
}

fn pill_frame(k: f32) -> egui::Frame {
    egui::Frame::NONE
        .fill(egui::Color32::from_rgba_unmultiplied(21, 24, 36, 235))
        .stroke(egui::Stroke::new(1.0, egui::Color32::from_white_alpha(32)))
        .corner_radius(32.0 * k)
        .inner_margin(egui::Margin::same((5.0 * k) as i8))
}

/// A flat text button for sheets and the grid.
fn soft(ui: &mut egui::Ui, text: &str, on: bool, w: f32, k: f32) -> egui::Response {
    let (fill, ink) = if on {
        (egui::Color32::from_rgba_unmultiplied(110, 91, 255, 54), egui::Color32::from_rgb(237, 239, 245))
    } else {
        (egui::Color32::from_rgb(21, 24, 36), egui::Color32::from_rgb(152, 161, 182))
    };
    // egui's own minimum for a button (40 points wide) is bigger than a sixth of this bar: it is asked for smaller.
    ui.spacing_mut().interact_size = egui::vec2(4.0 * k, 4.0 * k);
    ui.spacing_mut().button_padding = egui::vec2(2.0 * k, 2.0 * k);
    ui.add_sized([w, 36.0 * k], egui::Button::new(egui::RichText::new(text).size(13.0 * k).color(ink)).min_size(egui::vec2(w, 36.0 * k)).fill(fill).corner_radius(12.0 * k))
}

/// One entry of All tools.
struct Entry {
    item: Item,
    /// Which of `Catalogue::sections` it is listed under.
    section: usize,
    /// Whether a command could run when the list was made (tools and panels are asked each frame: that is cheap).
    enabled: bool,
    /// Its name and its section, lower case, for the search.
    find: String,
}

/// Every tool, panel and live command the editor has, by section, in the order the grid shows them.
struct Catalogue {
    entries: Vec<Entry>,
    sections: Vec<String>,
}

impl Catalogue {
    fn find(&self, id: &str) -> Option<Item> {
        self.entries.iter().find(|e| e.item.id == id).map(|e| e.item.clone())
    }
}

fn build_catalogue(app: &PhotocraftApp) -> Catalogue {
    let mut all: Vec<(Item, String, bool)> = Vec::new();
    for (group, tools) in TOOL_GROUPS {
        for t in tools {
            all.push((tool_item(*t), group.to_string(), true));
        }
    }
    for s in [Sheet::Layers, Sheet::Brush, Sheet::Colour] {
        all.push((sheet_item(s), "Panels".to_string(), true));
    }
    for m in menus::menu_items(app) {
        // The panels of the Window menu are the dock's, which is away; the sheets above are what the bar has instead.
        if m.label == "---" || m.id == "---" || m.path.first().is_some_and(|p| p == "Window") || !menus::is_live(&m.id) || m.id.starts_with("ui.") {
            continue;
        }
        let top = m.path.first().cloned().unwrap_or_default();
        let section = if m.path.is_empty() { "Other".to_string() } else { m.path.join(" › ") };
        all.push((command_item(&m.id, &m.label, &top), section, m.enabled));
    }
    let mut sections: Vec<String> = Vec::new();
    let entries = all
        .into_iter()
        .map(|(item, section, enabled)| {
            let at = sections.iter().position(|s| *s == section).unwrap_or_else(|| {
                sections.push(section.clone());
                sections.len() - 1
            });
            let find = format!("{}\n{}", item.label.to_lowercase(), section.to_lowercase());
            Entry { item, section: at, enabled, find }
        })
        .collect();
    Catalogue { entries, sections }
}

/// The catalogue as last made, or made now when there is none.
fn catalogue(app: &PhotocraftApp) -> std::rc::Rc<Catalogue> {
    if let Some(c) = RAIL.with(|p| p.borrow().catalogue.clone()) {
        return c;
    }
    let c = std::rc::Rc::new(build_catalogue(app));
    RAIL.with(|p| p.borrow_mut().catalogue = Some(c.clone()));
    c
}

/// After the app ran: the bar, the sheet and All tools over it. Drawn over the picture, never part of it.
fn rail_bar(app: &PhotocraftApp, ctx: &egui::Context) {
    RAIL.with(|p| {
        p.borrow_mut().ctx.get_or_insert_with(|| ctx.clone());
    });
    let phone = phone_on();
    let (sheet, grid, pins, toast) = RAIL.with(|p| {
        let p = p.borrow();
        (p.sheet, p.grid, p.pins.clone(), p.toast.clone())
    });
    let tool = app.ui.tool;
    let (can_undo, can_redo) = app.session.active().map_or((false, false), |s| (s.history.can_undo(), s.history.can_redo()));
    let mut asks: Vec<Ask> = Vec::new();
    let screen = ctx.content_rect();
    let panel = egui::Color32::from_rgb(14, 16, 22);
    let edge = egui::Stroke::new(1.0, egui::Color32::from_white_alpha(28));
    let k = per_css_px(ctx);
    // The sizes every Autora app's bar uses (docs/TOOL-RAIL.md, "Sizes"): 34px buttons on a desktop, 5px of padding.
    let size = if phone { 40.0 * k } else { 34.0 * k };
    let gap = if phone { 2.0 * k } else { 3.0 * k };
    let pad = if phone { 8.0 * k } else { 5.0 * k };

    // What the bar shows: a phone's defaults, a desktop's pins; as many as the window has room for.
    let all = catalogue(app);
    let ids = if phone { default_ids(true) } else { pins.clone().unwrap_or_else(|| default_ids(false)) };
    let room = if phone { screen.width() } else { screen.height() - 16.0 * k };
    let slots = (((room - 2.0 * pad - 12.0 * k + gap) / (size + gap)).floor() as usize).saturating_sub(1).max(1);
    let shown: Vec<Item> = ids.iter().filter_map(|id| all.find(id)).take(slots).collect();

    let on_of = |item: &Item| match &item.act {
        Act::Tool(t) => tool == *t,
        Act::Sheet(s) => sheet == Some(*s),
        Act::Command(_) => false,
    };
    let enabled_of = |item: &Item| match &item.act {
        Act::Command(id) if id == "edit.undo" => can_undo,
        Act::Command(id) if id == "edit.redo" => can_redo,
        Act::Command(id) => menus::is_enabled(app, id),
        Act::Sheet(Sheet::Brush) => painting(tool),
        _ => true,
    };
    let press = |item: &Item, asks: &mut Vec<Ask>| match &item.act {
        Act::Tool(t) => asks.push(Ask::Tool(*t)),
        Act::Sheet(s) => asks.push(Ask::Sheet(if sheet == Some(*s) { None } else { Some(*s) })),
        Act::Command(id) => asks.push(Ask::Command(id.clone(), serde_json::json!({}))),
    };

    let draw_buttons = |ui: &mut egui::Ui, asks: &mut Vec<Ask>| {
        for item in &shown {
            let tip = match &item.act {
                Act::Command(id) => photocraft_ui_egui::shortcuts::shortcut_label(app, id).map_or_else(|| item.label.clone(), |s| format!("{}  ({s})", item.label)),
                _ => item.label.clone(),
            };
            if round(ui, item.icon, item.color, on_of(item), enabled_of(item), size, &tip).clicked() {
                press(item, asks);
            }
        }
        if phone {
            ui.add_space(4.0 * k);
            ui.separator();
        } else {
            ui.add_space(2.0 * k);
            ui.separator();
        }
        let all_tools = round(ui, "panels-top-left", SLATE, grid, true, size, "All tools");
        RAIL.with(|p| p.borrow_mut().spots.grid_button = Some(all_tools.rect));
        if all_tools.clicked() {
            RAIL.with(|p| {
                let mut p = p.borrow_mut();
                p.grid = !grid;
                // Opened: the commands as they are now (what is enabled, Open Recent, plug-ins).
                if !grid {
                    p.catalogue = None;
                }
            });
            ctx.request_repaint();
        }
    };

    if phone {
        let bar_h = size + 2.0 * pad;
        egui::Area::new(egui::Id::new("autora-rail")).order(egui::Order::Foreground).fixed_pos(egui::pos2(0.0, screen.bottom() - bar_h)).show(ctx, |ui| {
            egui::Frame::NONE.fill(panel).stroke(edge).inner_margin(egui::Margin::symmetric((6.0 * k) as i8, (8.0 * k) as i8)).show(ui, |ui| {
                ui.set_width(screen.width() - 12.0 * k);
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = gap;
                    draw_buttons(ui, &mut asks);
                });
            });
        });
    } else {
        egui::Area::new(egui::Id::new("autora-rail")).order(egui::Order::Foreground).anchor(egui::Align2::RIGHT_CENTER, egui::vec2(-10.0 * k, 0.0)).show(ctx, |ui| {
            pill_frame(k).show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = gap;
                ui.vertical_centered(|ui| draw_buttons(ui, &mut asks));
            });
        });
    }

    // A sheet: beside the bar on a desktop, over it on a phone.
    if let Some(open) = sheet {
        let bar_w = size + 2.0 * pad;
        let (anchor, offset) = if phone { (egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -(size + 2.0 * pad + 8.0 * k))) } else { (egui::Align2::RIGHT_CENTER, egui::vec2(-(bar_w + 16.0 * k), 0.0)) };
        let full = if phone { (screen.width() - 24.0 * k).min(360.0 * k) } else { 300.0 * k };
        egui::Area::new(egui::Id::new("autora-sheet")).order(egui::Order::Foreground).anchor(anchor, offset).show(ctx, |ui| {
            egui::Frame::NONE.fill(panel).stroke(edge).corner_radius(16.0 * k).inner_margin(12.0 * k).show(ui, |ui| {
                ui.set_width(full);
                match open {
                    Sheet::Layers => {
                        let Some(st) = app.session.active() else {
                            ui.label("No picture open.");
                            return;
                        };
                        let active = st.active_layer;
                        ui.spacing_mut().item_spacing = egui::vec2(6.0 * k, 6.0 * k);
                        egui::ScrollArea::vertical().max_height(220.0 * k).show(ui, |ui| {
                            // Top layer first, as every editor lists them.
                            for l in st.doc.layers.iter().rev() {
                                ui.horizontal(|ui| {
                                    let eye = if l.visible { "Shown" } else { "Hidden" };
                                    if soft(ui, eye, l.visible, 64.0 * k, k).clicked() {
                                        asks.push(Ask::Command("layer.setProps".into(), serde_json::json!({"layer": l.id.0, "visible": !l.visible})));
                                    }
                                    if soft(ui, &l.name, active == Some(l.id), full - 64.0 * k - 6.0 * k, k).clicked() {
                                        asks.push(Ask::Command("layer.select".into(), serde_json::json!({"layer": l.id.0})));
                                    }
                                });
                            }
                        });
                        if let Some(l) = active.and_then(|id| st.doc.layer(id)) {
                            let mut pct = l.opacity * 100.0;
                            ui.spacing_mut().slider_width = full - 110.0 * k;
                            if ui.add(egui::Slider::new(&mut pct, 0.0..=100.0).text("Opacity")).changed() {
                                asks.push(Ask::Command("layer.setProps".into(), serde_json::json!({"layer": l.id.0, "opacity": pct / 100.0})));
                            }
                        }
                        ui.horizontal(|ui| {
                            let half = (full - 6.0 * k) / 2.0;
                            if soft(ui, "New layer", false, half, k).clicked() {
                                asks.push(Ask::Command("layer.new.layer".into(), serde_json::json!({})));
                            }
                            if soft(ui, "Delete", false, half, k).clicked() {
                                asks.push(Ask::Command("layer.delete".into(), serde_json::json!({})));
                            }
                        });
                    }
                    Sheet::Brush => {
                        let b = &app.session.tools.brush;
                        let (mut size, mut opacity) = (b.size, b.opacity * 100.0);
                        ui.spacing_mut().slider_width = full - 110.0 * k;
                        let a = ui.add(egui::Slider::new(&mut size, 1.0..=300.0).logarithmic(true).text("Size"));
                        let c = ui.add(egui::Slider::new(&mut opacity, 1.0..=100.0).text("Strength"));
                        if a.changed() || c.changed() {
                            asks.push(Ask::Brush { size: a.changed().then_some(size), opacity: c.changed().then_some(opacity / 100.0) });
                        }
                    }
                    Sheet::Colour => {
                        let mut colour = app.session.tools.foreground;
                        ui.horizontal(|ui| {
                            ui.label("Colour");
                            if ui.color_edit_button_rgba_unmultiplied(&mut colour).changed() {
                                asks.push(Ask::Colour(colour));
                            }
                        });
                    }
                }
            });
        });
    }

    // All tools: a modal in the middle of the screen, over a dimmed picture.
    if grid {
        egui::Area::new(egui::Id::new("autora-grid-scrim")).order(egui::Order::Foreground).fixed_pos(screen.min).show(ctx, |ui| {
            let r = ui.allocate_rect(screen, egui::Sense::click());
            ui.painter().rect_filled(screen, 0.0, egui::Color32::from_black_alpha(150));
            if r.clicked() {
                RAIL.with(|p| p.borrow_mut().grid = false);
            }
        });
        let width = if phone { (screen.width() - 24.0 * k).min(340.0 * k) } else { 560.0_f32.min(screen.width() - 32.0 * k) };
        egui::Area::new(egui::Id::new("autora-grid")).order(egui::Order::Tooltip).anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0)).show(ctx, |ui| {
            egui::Frame::NONE.fill(panel).stroke(edge).corner_radius(20.0 * k).inner_margin(14.0 * k).show(ui, |ui| {
                ui.set_width(width);
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("All tools").size(15.0 * k).strong());
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.small_button("Close").clicked() {
                            RAIL.with(|p| p.borrow_mut().grid = false);
                        }
                        if !phone && ui.small_button("Reset bar").clicked() {
                            asks.push(Ask::ResetPins);
                        }
                    });
                });
                let hint = toast.clone().unwrap_or_else(|| if phone { "Tap a tool to use it.".to_string() } else { format!("Pin the tools you use most to your bar. It has room for {slots} at this window size ({} pinned).", shown.len()) });
                ui.label(egui::RichText::new(hint).size(11.5 * k).color(egui::Color32::from_rgb(122, 130, 151)));
                let mut query = RAIL.with(|p| p.borrow().search.clone());
                let field = ui.add(egui::TextEdit::singleline(&mut query).hint_text("Search every tool and command").desired_width(width));
                RAIL.with(|p| p.borrow_mut().spots.search = Some((field.rect, field.id)));
                if field.changed() {
                    RAIL.with(|p| p.borrow_mut().search = query.clone());
                }
                let needle = query.trim().to_lowercase();
                let cols: usize = if phone { 3 } else { 5 };
                let tile_w = (width - 6.0 * k * (cols as f32 - 1.0) - 14.0 * k) / cols as f32;
                let aim = hand_aim();
                let mut tiles: Vec<(String, egui::Rect)> = Vec::new();
                let list = egui::ScrollArea::vertical().max_height(screen.height() * 0.7).max_width(width).auto_shrink([false, true]).show(ui, |ui| {
                    ui.spacing_mut().item_spacing = egui::vec2(6.0 * k, 6.0 * k);
                    for (at, section) in all.sections.iter().enumerate() {
                        let items: Vec<&Entry> = all.entries.iter().filter(|e| e.section == at && (needle.is_empty() || e.find.contains(&needle))).collect();
                        if items.is_empty() {
                            continue;
                        }
                        let commands = items.first().is_some_and(|e| matches!(e.item.act, Act::Command(_)));
                        let mut body = |ui: &mut egui::Ui, asks: &mut Vec<Ask>| {
                            for row in items.chunks(cols) {
                                ui.horizontal(|ui| {
                                for entry in row {
                                    let item = &entry.item;
                                    let on = on_of(item);
                                    let enabled = if matches!(item.act, Act::Command(_)) { entry.enabled } else { enabled_of(item) };
                                    let pinned = ids.contains(&item.id);
                                    ui.vertical(|ui| {
                                        ui.set_width(tile_w);
                                        let (rect, resp) = ui.allocate_exact_size(egui::vec2(tile_w, 54.0 * k), if enabled { egui::Sense::click() } else { egui::Sense::hover() });
                                        tiles.push((item.id.clone(), rect));
                                        // The tile the agent's hand is going to: scrolled into view, as a person scrolls to it.
                                        if aim.as_deref() == Some(item.id.as_str()) {
                                            ui.scroll_to_rect(rect, Some(egui::Align::Center));
                                        }
                                        let resp = resp.on_hover_text(&item.label);
                                        let fill = with_alpha(item.color, if on { 90 } else if resp.hovered() && enabled { 60 } else { 38 });
                                        ui.painter().rect_filled(rect, 14.0 * k, if enabled { fill } else { with_alpha(item.color, 18) });
                                        let ink = if enabled { item.color } else { with_alpha(item.color, 90) };
                                        icons::paint(ui, egui::Rect::from_center_size(rect.center_top() + egui::vec2(0.0, 18.0 * k), egui::vec2(20.0 * k, 20.0 * k)), item.icon, 18.0 * k, ink);
                                        let label: String = if item.label.chars().count() > 16 { format!("{}…", item.label.chars().take(15).collect::<String>()) } else { item.label.clone() };
                                        ui.painter().text(rect.center_bottom() + egui::vec2(0.0, -9.0 * k), egui::Align2::CENTER_CENTER, label, egui::FontId::proportional(10.5 * k), if enabled { egui::Color32::from_rgb(237, 239, 245) } else { egui::Color32::from_rgb(122, 130, 151) });
                                        if resp.clicked() {
                                            press(item, asks);
                                        }
                                        if !phone {
                                            let pr = ui.allocate_exact_size(egui::vec2(tile_w, 14.0 * k), egui::Sense::click());
                                            ui.painter().text(pr.0.center(), egui::Align2::CENTER_CENTER, if pinned { "Pinned" } else { "Pin to bar" }, egui::FontId::proportional(9.5 * k), if pinned { item.color } else { egui::Color32::from_rgb(122, 130, 151) });
                                            if pr.1.clicked() {
                                                if !pinned && shown.len() >= slots {
                                                    RAIL.with(|p| p.borrow_mut().toast = Some("The bar is full. Unpin a tool first.".into()));
                                                } else {
                                                    RAIL.with(|p| p.borrow_mut().toast = None);
                                                    asks.push(Ask::Pin(item.id.clone()));
                                                }
                                            }
                                        }
                                    });
                                }
                                });
                            }
                        };
                        if commands && needle.is_empty() {
                            egui::CollapsingHeader::new(egui::RichText::new(section).size(11.5 * k).color(egui::Color32::from_rgb(152, 161, 182))).id_salt(section).default_open(false).show(ui, |ui| body(ui, &mut asks));
                        } else {
                            ui.label(egui::RichText::new(section.to_uppercase()).size(10.5 * k).color(egui::Color32::from_rgb(122, 130, 151)));
                            body(ui, &mut asks);
                        }
                    }
                });
                RAIL.with(|p| {
                    let mut p = p.borrow_mut();
                    p.spots.tiles = tiles;
                    p.spots.list = Some(list.inner_rect);
                });
            });
        });
    } else {
        RAIL.with(|p| {
            let mut p = p.borrow_mut();
            p.spots.tiles.clear();
            p.spots.search = None;
            p.spots.list = None;
        });
    }

    if !asks.is_empty() {
        RAIL.with(|p| p.borrow_mut().asks.extend(asks));
        ctx.request_repaint();
    }
}

// ---- the agent's hand --------------------------------------------------------------------------------------------
//
// With Visible work on, the agent's photo_edit is not run on the server's copy of the picture: the window hands it here,
// and the agent does it in this editor as a person does, with the same controls. Its cursor (drawn here, in its colour,
// with its name) goes to All tools on the bar and clicks it, clicks the search field and types the command's name, goes
// to the command's tile (scrolling the list to it) and clicks it. The command's own dialog opens; each of the agent's
// values is set in it in turn, a number moving to its value as a slider does and words typed, while the person watches
// the preview change; then the cursor clicks OK. A command with nothing to set does what its tile does for anyone.
//
// Every move, press and key is an input event of the editor's own (`raw_input`, fed through eframe's raw input hook), so
// the bar, the search field and the dialog's buttons answer the hand exactly as they answer a mouse. When the edit is
// done the picture goes back to the page with what each command did (`handed`), and the window keeps it as the agent's.
//
// What is not done by hand yet, and says so in its result (`how: "direct"`): a command with no tile in All tools (one
// that is in no menu, such as layer.setProps) runs as the editor's own command while the cursor rests on the picture.

use std::collections::VecDeque;

/// How long a key takes, between two, in milliseconds: a person typing at an ordinary pace.
const HAND_TYPE_MS: (f64, f64) = (55.0, 115.0);

#[derive(Clone, Copy, PartialEq, Debug)]
enum Target {
    GridButton,
    Search,
    Tile,
    Field(usize),
    Ok,
    Picture,
}

#[derive(Clone)]
enum Step {
    Go(Target),
    Press,
    Release,
    Pause(f64),
    /// Select what is in the focused field (Ctrl/Cmd+A), so what is typed replaces it.
    SelectAll,
    Type(String),
    /// After the tile: wait for its dialog, or for the command it ran.
    AwaitTile,
    /// Set the agent's value number `n` in the open dialog, over a moment.
    SetField(usize),
    /// After OK: wait for the dialog to close and the command (and any job it started) to finish.
    AwaitOk,
    /// No tile for it: the editor's own command, run directly.
    Direct,
}

struct Motion {
    from: egui::Pos2,
    to: egui::Pos2,
    bend: egui::Pos2,
    start: f64,
    dur: f64,
}

struct HandJob {
    id: String,
    cmds: Vec<(String, serde_json::Map<String, serde_json::Value>)>,
    n: usize,
    acts: VecDeque<Step>,
    since: f64,
    motion: Option<Motion>,
    results: Vec<serde_json::Value>,
    stop: bool,
    // The command in hand.
    item: String,
    label: String,
    how: &'static str,
    before: Vec<u64>,
    dialog: Option<u64>,
    pressed: bool,
    outcome: Option<Result<(), String>>,
    typed: usize,
    next_key: f64,
    field_from: Option<f64>,
    ok_tries: u8,
}

#[derive(Default)]
struct Hand {
    job: Option<HandJob>,
    /// Input for the next frame.
    events: Vec<egui::Event>,
    at: Option<egui::Pos2>,
    name: String,
    color: Option<egui::Color32>,
    /// When the last job ended: the cursor stays a moment, then goes.
    ended: f64,
    told: f64,
    bend_side: f32,
}

thread_local! {
    static HAND: RefCell<Hand> = RefCell::new(Hand::default());
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

fn rand(lo: f64, hi: f64) -> f64 {
    lo + (hi - lo) * js_sys::Math::random()
}

/// A job from the page. One at a time: a second while one is in hand is answered at once, as refused.
fn hand_take(json: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return };
    let Some(id) = v.get("id").and_then(|x| x.as_str()).map(str::to_string) else { return };
    let cmds: Vec<(String, serde_json::Map<String, serde_json::Value>)> = v
        .get("commands")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    let cid = c.get("id").and_then(|x| x.as_str())?.to_string();
                    let params = c.get("params").and_then(|p| p.as_object()).cloned().unwrap_or_default();
                    Some((cid, params))
                })
                .collect()
        })
        .unwrap_or_default();
    let busy = HAND.with(|h| h.borrow().job.is_some());
    if busy {
        let reply = serde_json::json!({ "id": id, "error": "The editor is already doing an edit." });
        send_json("handed", &reply.to_string(), None).ok();
        return;
    }
    HAND.with(|h| {
        let mut h = h.borrow_mut();
        if let Some(who) = v.get("who") {
            h.name = who.get("name").and_then(|x| x.as_str()).unwrap_or("Autora").chars().take(24).collect();
            h.color = who.get("color").and_then(|x| x.as_str()).and_then(|c| egui::Color32::from_hex(c.trim()).ok());
        }
        h.job = Some(HandJob {
            id,
            cmds,
            n: 0,
            acts: VecDeque::new(),
            since: now_ms(),
            motion: None,
            results: Vec::new(),
            stop: false,
            item: String::new(),
            label: String::new(),
            how: "ui",
            before: Vec::new(),
            dialog: None,
            pressed: false,
            outcome: None,
            typed: 0,
            next_key: 0.0,
            field_from: None,
            ok_tries: 0,
        });
    });
}

fn send_json(kind: &str, json: &str, bytes: Option<&[u8]>) -> Result<(), String> {
    let js = |e: JsValue| format!("{e:?}");
    let up = parent().ok_or("not framed")?;
    let origin = window().ok_or("no window")?.location().origin().map_err(js)?;
    let msg = Object::new();
    Reflect::set(&msg, &NS.into(), &kind.into()).map_err(js)?;
    Reflect::set(&msg, &"json".into(), &json.into()).map_err(js)?;
    if let Some(bytes) = bytes {
        Reflect::set(&msg, &"bytes".into(), &Uint8Array::from(bytes).buffer()).map_err(js)?;
    }
    up.post_message(&msg, &origin).map_err(js)
}

fn hand_busy() -> bool {
    HAND.with(|h| h.borrow().job.is_some())
}

/// The tile the hand is on its way to, so All tools scrolls it into view.
fn hand_aim() -> Option<String> {
    HAND.with(|h| h.borrow().job.as_ref().filter(|j| !j.pressed && !j.item.is_empty()).map(|j| j.item.clone()))
}

/// The bar was asked for command `id`: if that is the hand pressing the tile of the command it is doing, its label and
/// whether it has values to set (so its dialog is opened for them).
fn hand_pressed(id: &str) -> Option<(String, bool)> {
    HAND.with(|h| {
        let mut h = h.borrow_mut();
        let j = h.job.as_mut()?;
        let (cid, params) = j.cmds.get(j.n)?;
        if j.pressed || cid != id || j.item.is_empty() {
            return None;
        }
        j.pressed = true;
        Some((j.label.clone(), !params.is_empty()))
    })
}

/// What the command the hand's tile ran said.
fn hand_result(r: Result<serde_json::Value, String>) {
    HAND.with(|h| {
        if let Some(j) = h.borrow_mut().job.as_mut() {
            j.outcome = Some(r.map(|_| ()));
        }
    });
}

/// The hand's input, into the frame's raw input (eframe's raw input hook, patched in by build-photo.mjs).
pub fn raw_input(raw: &mut egui::RawInput) {
    HAND.with(|h| raw.events.append(&mut h.borrow_mut().events));
}

fn ease(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 }
}

impl Motion {
    fn at(&self, now: f64) -> (egui::Pos2, bool) {
        let t = ((now - self.start) / self.dur).clamp(0.0, 1.0);
        let e = ease(t) as f32;
        let a = self.from.lerp(self.bend, e);
        let b = self.bend.lerp(self.to, e);
        (a.lerp(b, e), t >= 1.0)
    }
}

/// Where a target is on screen now, if it is there.
fn spot(app: &PhotocraftApp, ctx: &egui::Context, j: &HandJob, t: Target) -> Option<egui::Pos2> {
    let rail = |f: &dyn Fn(&Spots) -> Option<egui::Rect>| RAIL.with(|p| f(&p.borrow().spots));
    let inside = |r: egui::Rect| r.center() + egui::vec2(rand(-0.2, 0.2) as f32 * r.width(), rand(-0.2, 0.2) as f32 * r.height());
    match t {
        Target::GridButton => rail(&|s| s.grid_button).map(inside),
        Target::Search => rail(&|s| s.search.map(|(r, _)| r)).map(|r| egui::pos2(r.left() + r.width() * 0.3, r.center().y)),
        Target::Tile => {
            let r = rail(&|s| s.tiles.iter().find(|(id, _)| *id == j.item).map(|(_, r)| *r))?;
            // Only once the list has scrolled to it.
            let shown = rail(&|s| s.list).is_none_or(|l| l.contains(r.center()));
            shown.then(|| inside(r))
        }
        Target::Ok => {
            app.ui.dialogs.iter().any(|d| Some(d.id) == j.dialog).then_some(())?;
            ctx.data(|d| d.get_temp::<egui::Rect>(egui::Id::new("autora-dialog-ok"))).map(inside)
        }
        Target::Field(i) => {
            let did = j.dialog?;
            let ok = ctx.data(|d| d.get_temp::<egui::Rect>(egui::Id::new("autora-dialog-ok")));
            let area = ctx.memory(|m| m.area_rect(egui::Id::new(("dialog", did)))).or_else(|| ok.map(|o| egui::Rect::from_min_max(egui::pos2(o.right() - 400.0, o.top() - 220.0), egui::pos2(o.right(), o.top() - 8.0))))?;
            let y = (area.top() + 64.0 + i as f32 * 30.0).min(area.bottom() - 60.0).max(area.top() + 30.0);
            Some(egui::pos2(area.left() + area.width() * rand(0.45, 0.65) as f32, y))
        }
        Target::Picture => Some(ctx.content_rect().center() + egui::vec2(rand(-60.0, 60.0) as f32, rand(-40.0, 40.0) as f32)),
    }
}

/// Every frame, before the app runs: the hand's next movement, press or key.
fn hand_pump(app: &mut PhotocraftApp) {
    let Some(ctx) = RAIL.with(|p| p.borrow().ctx.clone()) else { return };
    if !hand_busy() {
        return;
    }
    ctx.request_repaint();
    let now = now_ms();
    let k = per_css_px(&ctx);
    // The hand is taken out while it works, and put back after, so the app can be borrowed freely in between.
    let mut h = HAND.with(|h| std::mem::take(&mut *h.borrow_mut()));
    let Some(mut j) = h.job.take() else {
        HAND.with(|x| *x.borrow_mut() = h);
        return;
    };
    let mut events: Vec<egui::Event> = Vec::new();
    let at = h.at.unwrap_or_else(|| ctx.content_rect().center());
    let mut pos = at;

    if j.acts.is_empty() {
        if j.stop || j.n >= j.cmds.len() {
            hand_finish(app, &j);
            h.ended = now;
            HAND.with(|x| *x.borrow_mut() = h);
            return;
        }
        // The next command: by hand through All tools when it has a tile there, else the editor's own command.
        let (cid, _) = j.cmds[j.n].clone();
        let item = format!("c:{cid}");
        let found = catalogue(app).find(&item);
        j.before = app.ui.dialogs.iter().map(|d| d.id).collect();
        j.dialog = None;
        j.pressed = false;
        j.outcome = None;
        j.ok_tries = 0;
        j.since = now;
        match found {
            Some(it) => {
                j.item = item;
                j.label = it.label.clone();
                j.how = "ui";
                let grid = RAIL.with(|p| p.borrow().grid);
                if !grid {
                    j.acts.extend([Step::Go(Target::GridButton), Step::Press, Step::Release, Step::Pause(rand(220.0, 320.0))]);
                }
                j.acts.extend([
                    Step::Go(Target::Search),
                    Step::Press,
                    Step::Release,
                    Step::Pause(rand(120.0, 200.0)),
                    Step::SelectAll,
                    Step::Type(it.label.to_lowercase()),
                    Step::Pause(rand(280.0, 420.0)),
                    Step::Go(Target::Tile),
                    Step::Pause(rand(60.0, 140.0)),
                    Step::Press,
                    Step::Release,
                    Step::AwaitTile,
                ]);
            }
            None => {
                j.item.clear();
                j.label = cid.clone();
                j.how = "direct";
                j.acts.extend([Step::Go(Target::Picture), Step::Pause(160.0), Step::Direct]);
            }
        }
    }

    let fail = |j: &mut HandJob, app: &mut PhotocraftApp, why: String| {
        let (cid, _) = &j.cmds[j.n];
        j.results.push(serde_json::json!({ "command": cid, "ok": false, "error": why, "how": j.how }));
        if let Some(d) = j.dialog.take() {
            app.ui.close_dialog(d);
        }
        RAIL.with(|p| p.borrow_mut().grid = false);
        j.stop = true;
        j.acts.clear();
    };
    let elapsed = now - j.since;
    let mut next = false;
    match j.acts.front().cloned() {
        Some(Step::Go(t)) => {
            if j.motion.is_none() {
                match spot(app, &ctx, &j, t) {
                    Some(to) => {
                        let d = (to - at).length() / k.max(0.25);
                        let dur = 260.0 + 115.0 * (1.0 + d as f64 / 24.0).log2();
                        h.bend_side = if h.bend_side >= 0.0 { -1.0 } else { 1.0 };
                        let mid = at.lerp(to, 0.5);
                        let perp = (to - at).rot90().normalized() * (to - at).length() * 0.14 * h.bend_side;
                        j.motion = Some(Motion { from: at, to, bend: mid + perp, start: now, dur });
                    }
                    None if elapsed > 2500.0 => {
                        fail(&mut j, app, format!("the hand could not find {t:?} on screen"));
                    }
                    None => {}
                }
            }
            if let Some(m) = &j.motion {
                let (p, arrived) = m.at(now);
                let tremor = egui::vec2(((now / 37.0).sin() * 0.35) as f32, ((now / 53.0).cos() * 0.35) as f32) * k;
                pos = if arrived { p } else { p + tremor };
                events.push(egui::Event::PointerMoved(pos));
                if arrived {
                    j.motion = None;
                    next = true;
                }
            }
        }
        Some(Step::Press) => {
            events.push(egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed: true, modifiers: egui::Modifiers::NONE });
            next = true;
        }
        Some(Step::Release) => {
            events.push(egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed: false, modifiers: egui::Modifiers::NONE });
            next = true;
        }
        Some(Step::Pause(ms)) => next = elapsed >= ms,
        Some(Step::SelectAll) => {
            // The click gave the search field the keyboard; if it did not, it is given it, so no key reaches the canvas.
            if let Some((_, id)) = RAIL.with(|p| p.borrow().spots.search) {
                if !ctx.memory(|m| m.has_focus(id)) {
                    ctx.memory_mut(|m| m.request_focus(id));
                }
            }
            let m = egui::Modifiers::COMMAND;
            events.push(egui::Event::Key { key: egui::Key::A, physical_key: None, pressed: true, repeat: false, modifiers: m });
            events.push(egui::Event::Key { key: egui::Key::A, physical_key: None, pressed: false, repeat: false, modifiers: m });
            next = true;
        }
        Some(Step::Type(text)) => {
            let chars: Vec<char> = text.chars().collect();
            let focused = RAIL.with(|p| p.borrow().spots.search).is_some_and(|(_, id)| ctx.memory(|m| m.has_focus(id)));
            if !focused {
                if elapsed > 1500.0 {
                    fail(&mut j, app, "the search field did not take the keyboard".into());
                }
            } else if j.typed >= chars.len() {
                j.typed = 0;
                next = true;
            } else if now >= j.next_key {
                events.push(egui::Event::Text(chars[j.typed].to_string()));
                j.typed += 1;
                j.next_key = now + rand(HAND_TYPE_MS.0, HAND_TYPE_MS.1);
            }
        }
        Some(Step::AwaitTile) => {
            let opened = app.ui.dialogs.iter().map(|d| d.id).find(|id| !j.before.contains(id));
            if let Some(did) = opened {
                if app.ui.dialogs.iter().any(|d| d.id == did && d.kind == photocraft_ui_egui::state::DialogKind::Error) {
                    let why = app.ui.dialogs.iter().find(|d| d.id == did).and_then(|d| d.fields.get("message")).and_then(|m| m.as_str()).unwrap_or("it failed").to_string();
                    app.ui.close_dialog(did);
                    fail(&mut j, app, why);
                } else {
                    j.dialog = Some(did);
                    let fields = j.cmds[j.n].1.len();
                    j.acts.pop_front();
                    for i in 0..fields {
                        j.acts.push_back(Step::Go(Target::Field(i)));
                        j.acts.push_back(Step::SetField(i));
                        j.acts.push_back(Step::Pause(rand(140.0, 260.0)));
                    }
                    j.acts.extend([Step::Pause(rand(200.0, 320.0)), Step::Go(Target::Ok), Step::Pause(rand(60.0, 140.0)), Step::Press, Step::Release, Step::AwaitOk]);
                    ctx.data_mut(|m| m.remove::<Option<String>>(egui::Id::new("autora-dialog-result")));
                    j.since = now;
                }
            } else {
                match j.outcome.take() {
                    Some(Ok(())) if !app.session.has_jobs() => next = true,
                    Some(Ok(())) => j.outcome = Some(Ok(())),
                    Some(Err(e)) => fail(&mut j, app, e),
                    None if elapsed > 3000.0 => fail(&mut j, app, "its tile did not answer the click".into()),
                    None => {}
                }
            }
        }
        Some(Step::SetField(i)) => {
            let (key, want) = j.cmds[j.n].1.iter().nth(i).map(|(k, v)| (k.clone(), v.clone())).unwrap_or_default();
            let did = j.dialog.unwrap_or(u64::MAX);
            let current = app.ui.dialogs.iter().find(|d| d.id == did).and_then(|d| d.fields.get(&key)).cloned();
            match (&want, current.as_ref().and_then(|c| c.as_f64())) {
                // A number moves to its value, as a slider dragged there; the dialog's preview follows it.
                (serde_json::Value::Number(n), Some(from)) if n.as_f64().is_some() => {
                    let to = n.as_f64().unwrap_or(from);
                    let start = *j.field_from.get_or_insert(from);
                    let t = (elapsed / 520.0).clamp(0.0, 1.0);
                    let v = start + (to - start) * ease(t);
                    let value = if t >= 1.0 { want.clone() } else if n.is_f64() { serde_json::json!(v) } else { serde_json::json!(v.round() as i64) };
                    if let Some(d) = app.ui.dialog_mut(did) {
                        d.fields.insert(key, value);
                    }
                    pos += egui::vec2(((t - 0.5) * 40.0) as f32 * k * ((to - start).signum() as f32), 0.0);
                    events.push(egui::Event::PointerMoved(pos));
                    if t >= 1.0 {
                        j.field_from = None;
                        next = true;
                    }
                }
                // Words are typed into it.
                (serde_json::Value::String(text), _) => {
                    let chars: Vec<char> = text.chars().collect();
                    if j.typed >= chars.len() {
                        if let Some(d) = app.ui.dialog_mut(did) {
                            d.fields.insert(key, want.clone());
                        }
                        j.typed = 0;
                        next = true;
                    } else if now >= j.next_key {
                        j.typed += 1;
                        let shown: String = chars[..j.typed].iter().collect();
                        if let Some(d) = app.ui.dialog_mut(did) {
                            d.fields.insert(key, serde_json::json!(shown));
                        }
                        j.next_key = now + rand(HAND_TYPE_MS.0, HAND_TYPE_MS.1);
                    }
                }
                // A switch, a choice or a value the dialog had none of: set as it is.
                _ => {
                    if let Some(d) = app.ui.dialog_mut(did) {
                        d.fields.insert(key, want.clone());
                    }
                    next = true;
                }
            }
        }
        Some(Step::AwaitOk) => {
            let open = j.dialog.is_some_and(|d| app.ui.dialogs.iter().any(|x| x.id == d));
            let said = ctx.data(|m| m.get_temp::<Option<String>>(egui::Id::new("autora-dialog-result")));
            if !open {
                if app.session.has_jobs() {
                    // A filter running as a job: wait for it, however long a large picture takes.
                } else {
                    match said {
                        Some(Some(e)) => fail(&mut j, app, e),
                        _ => {
                            j.dialog = None;
                            next = true;
                        }
                    }
                }
            } else if elapsed > 1800.0 {
                // The click missed (the dialog moved, or was still being laid out): try OK again, twice.
                j.ok_tries += 1;
                if j.ok_tries > 2 {
                    fail(&mut j, app, "the dialog's OK did not take the click".into());
                } else {
                    j.acts.pop_front();
                    for a in [Step::AwaitOk, Step::Release, Step::Press, Step::Go(Target::Ok)] {
                        j.acts.push_front(a);
                    }
                    j.since = now;
                }
            }
        }
        Some(Step::Direct) => {
            if j.outcome.is_none() {
                let (cid, params) = j.cmds[j.n].clone();
                let r = menus::invoke(app, &ctx, &cid, serde_json::Value::Object(params));
                j.outcome = Some(r.map(|_| ()));
            }
            match j.outcome.clone() {
                Some(Err(e)) => fail(&mut j, app, e),
                _ if app.session.has_jobs() => {}
                _ => next = true,
            }
        }
        None => {}
    }
    if next && !j.stop {
        j.acts.pop_front();
        j.since = now;
        if j.acts.is_empty() {
            let (cid, _) = &j.cmds[j.n];
            j.results.push(serde_json::json!({ "command": cid, "ok": true, "how": j.how }));
            j.n += 1;
            j.item.clear();
        }
    }
    h.at = Some(pos);
    h.events.extend(events);
    h.job = Some(j);
    HAND.with(|x| *x.borrow_mut() = h);
}

/// The edit is done (or stopped): the picture and what each command did, to the page.
fn hand_finish(app: &PhotocraftApp, j: &HandJob) {
    let mut reply = serde_json::json!({ "id": j.id, "results": j.results });
    let bytes = app.session.active().and_then(|st| {
        let key = (st.doc.id, st.revision);
        match photocraft_io::export(&st.doc, WORK_NAME, &ExportOptions::default()) {
            Ok(done) => {
                SYNC.with(|s| s.borrow_mut().sent = Some(key));
                Some(done.bytes)
            }
            Err(e) => {
                reply["error"] = serde_json::json!(format!("the picture could not be kept: {e}"));
                None
            }
        }
    });
    if bytes.is_none() && reply.get("error").is_none() {
        reply["error"] = serde_json::json!("no picture is open in the editor");
    }
    send_json("handed", &reply.to_string(), bytes.as_deref()).ok();
}

/// After the app ran: the agent's cursor over everything, in its colour and with its name, while it works and a moment after.
fn hand_draw(ctx: &egui::Context) {
    let (at, busy, ended, name, color) = HAND.with(|h| {
        let h = h.borrow();
        (h.at, h.job.is_some(), h.ended, h.name.clone(), h.color)
    });
    let Some(at) = at else { return };
    let now = now_ms();
    if !busy && now - ended > 1500.0 {
        return;
    }
    if !busy {
        ctx.request_repaint_after(Duration::from_millis(100));
    }
    let k = per_css_px(ctx);
    let color = color.unwrap_or(egui::Color32::from_rgb(110, 91, 255));
    let painter = ctx.layer_painter(egui::LayerId::new(egui::Order::Debug, egui::Id::new("autora-hand")));
    let arrow: Vec<egui::Pos2> = [(0.0, 0.0), (0.0, 17.0), (4.6, 13.2), (7.6, 20.0), (10.2, 18.9), (7.3, 12.4), (12.6, 12.4)].iter().map(|(x, y)| at + egui::vec2(*x, *y) * k).collect();
    painter.add(egui::Shape::convex_polygon(arrow, color, egui::Stroke::new(1.4 * k, egui::Color32::WHITE)));
    let label = if name.is_empty() { "Autora".to_string() } else { name };
    let galley = painter.layout_no_wrap(label, egui::FontId::proportional(11.0 * k), egui::Color32::WHITE);
    let tag = egui::Rect::from_min_size(at + egui::vec2(14.0, 18.0) * k, galley.size() + egui::vec2(12.0, 6.0) * k);
    painter.rect_filled(tag, 6.0 * k, color);
    painter.galley(tag.min + egui::vec2(6.0, 3.0) * k, galley, egui::Color32::WHITE);
    // Where it is, for the few words the page shows beside it; a few times a second is enough.
    let told = HAND.with(|h| h.borrow().told);
    if busy && now - told > 80.0 {
        HAND.with(|h| h.borrow_mut().told = now);
        let msg = Object::new();
        let _ = Reflect::set(&msg, &NS.into(), &"cursor".into());
        let _ = Reflect::set(&msg, &"x".into(), &JsValue::from_f64(f64::from(at.x / k.max(0.01))));
        let _ = Reflect::set(&msg, &"y".into(), &JsValue::from_f64(f64::from(at.y / k.max(0.01))));
        if let (Some(up), Some(origin)) = (parent(), window().and_then(|w| w.location().origin().ok())) {
            let _ = up.post_message(&msg, &origin);
        }
    }
}
