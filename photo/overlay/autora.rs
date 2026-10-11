//! Autora's side of the PhotoCraft window (copied into apps/photocraft-web/src/ by scripts/build-photo.mjs).
//!
//! PhotoCraft runs in a frame of Autora's page (components/PhotoWindow.tsx), and the two talk by postMessage only. All
//! of it is inert when the page is not framed, so the same build still works on its own.
//!
//! Page -> editor:
//!   { autoraPhoto: "load", name, bytes }   the working picture, as a .pcraft: it replaces what is open
//!
//! Editor -> page:
//!   { autoraPhoto: "ready" }               the editor is up and listening
//!   { autoraPhoto: "changed", name, bytes } the person changed the picture (a .pcraft, after a pause in their edits)
//!   { autoraPhoto: "file", name, bytes }   the person saved or exported a file (File > Save, Export): the page offers it
//!                                          as a download, since a frame cannot start one the way a page can
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
        if !data.is_object() || Reflect::get(&data, &NS.into()).ok().and_then(|v| v.as_string()).as_deref() != Some("load") {
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

fn resolve(id: &str, items: &[(Item, String)]) -> Option<Item> {
    items.iter().find(|(i, _)| i.id == id).map(|(i, _)| i.clone())
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
                RAIL.with(|p| p.borrow_mut().grid = false);
                drop(menus::invoke(app, ctx, &id, params));
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
    matches!(tool, Tool::Brush | Tool::Pencil | Tool::Eraser | Tool::PaintBucket | Tool::MixerBrush | Tool::Pencil)
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
        .inner_margin(egui::Margin::same((6.0 * k) as i8))
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

/// Every tool, panel and live command the editor has, with the section each is listed under.
fn catalogue(app: &PhotocraftApp) -> Vec<(Item, String)> {
    let mut all: Vec<(Item, String)> = Vec::new();
    for (group, tools) in TOOL_GROUPS {
        for t in tools {
            all.push((tool_item(*t), group.to_string()));
        }
    }
    for s in [Sheet::Layers, Sheet::Brush, Sheet::Colour] {
        all.push((sheet_item(s), "Panels".to_string()));
    }
    for m in menus::menu_items(app) {
        // The panels of the Window menu are the dock's, which is away; the sheets above are what the bar has instead.
        if m.label == "---" || m.id == "---" || m.path.first().is_some_and(|p| p == "Window") || !menus::is_live(&m.id) || m.id.starts_with("ui.") {
            continue;
        }
        let top = m.path.first().cloned().unwrap_or_default();
        let section = if m.path.is_empty() { "Other".to_string() } else { m.path.join(" › ") };
        let mut item = command_item(&m.id, &m.label, &top);
        if !m.enabled {
            item.label = format!("{}", item.label);
        }
        all.push((item, section));
    }
    all
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
    let size = if phone { 40.0 * k } else { 44.0 * k };
    let gap = if phone { 2.0 * k } else { 4.0 * k };
    let pad = 8.0 * k;

    // What the bar shows: a phone's defaults, a desktop's pins; as many as the window has room for.
    let all = catalogue(app);
    let ids = if phone { default_ids(true) } else { pins.clone().unwrap_or_else(|| default_ids(false)) };
    let room = if phone { screen.width() } else { screen.height() - 16.0 * k };
    let slots = (((room - 2.0 * pad - 12.0 * k + gap) / (size + gap)).floor() as usize).saturating_sub(1).max(1);
    let shown: Vec<Item> = ids.iter().filter_map(|id| resolve(id, &all)).take(slots).collect();

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
        if round(ui, "panels-top-left", SLATE, grid, true, size, "All tools").clicked() {
            RAIL.with(|p| p.borrow_mut().grid = !grid);
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
        egui::Area::new(egui::Id::new("autora-rail")).order(egui::Order::Foreground).anchor(egui::Align2::RIGHT_CENTER, egui::vec2(-8.0 * k, 0.0)).show(ctx, |ui| {
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
                if ui.add(egui::TextEdit::singleline(&mut query).hint_text("Search every tool and command").desired_width(width)).changed() {
                    RAIL.with(|p| p.borrow_mut().search = query.clone());
                }
                let needle = query.trim().to_lowercase();
                let cols: usize = if phone { 3 } else { 5 };
                let tile_w = (width - 6.0 * k * (cols as f32 - 1.0) - 14.0 * k) / cols as f32;
                egui::ScrollArea::vertical().max_height(screen.height() * 0.7).max_width(width).auto_shrink([false, true]).show(ui, |ui| {
                    ui.spacing_mut().item_spacing = egui::vec2(6.0 * k, 6.0 * k);
                    let mut sections: Vec<String> = Vec::new();
                    for (_, s) in &all {
                        if !sections.contains(s) {
                            sections.push(s.clone());
                        }
                    }
                    for section in sections {
                        let items: Vec<&Item> = all.iter().filter(|(i, s)| *s == section && (needle.is_empty() || i.label.to_lowercase().contains(&needle) || s.to_lowercase().contains(&needle))).map(|(i, _)| i).collect();
                        if items.is_empty() {
                            continue;
                        }
                        let commands = items.first().is_some_and(|i| matches!(i.act, Act::Command(_)));
                        let body = |ui: &mut egui::Ui, asks: &mut Vec<Ask>| {
                            for row in items.chunks(cols) {
                                ui.horizontal(|ui| {
                                for item in row {
                                    let on = on_of(item);
                                    let enabled = enabled_of(item);
                                    let pinned = ids.contains(&item.id);
                                    ui.vertical(|ui| {
                                        ui.set_width(tile_w);
                                        let (rect, resp) = ui.allocate_exact_size(egui::vec2(tile_w, 54.0 * k), if enabled { egui::Sense::click() } else { egui::Sense::hover() });
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
                            egui::CollapsingHeader::new(egui::RichText::new(&section).size(11.5 * k).color(egui::Color32::from_rgb(152, 161, 182))).id_salt(&section).default_open(false).show(ui, |ui| body(ui, &mut asks));
                        } else {
                            ui.label(egui::RichText::new(section.to_uppercase()).size(10.5 * k).color(egui::Color32::from_rgb(122, 130, 151)));
                            body(ui, &mut asks);
                        }
                    }
                });
            });
        });
    }

    if !asks.is_empty() {
        RAIL.with(|p| p.borrow_mut().asks.extend(asks));
        ctx.request_repaint();
    }
}
