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
