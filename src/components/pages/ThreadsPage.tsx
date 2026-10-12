import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "../Markdown";
import {
  IconArrowDown, IconArrowLeft, IconArrowUp, IconChevron, IconEdit, IconLock, IconMessage, IconPin, IconPlus,
  IconSearch, IconStar, IconThreads, IconTrash,
} from "../Icons";
import { AgentDot } from "./OrganizationPage";
import {
  ME, deleteComment, deletePost, editComment, editPost, fetchPosts, likeIn, makeComment, makePost, markPost, scoreOf,
  type ThreadComment, type ThreadPost, type ThreadSort, type ThreadTag, type Who,
} from "../../lib/organization";
import { ago } from "../../lib/ago";
import { every } from "../../lib/poll";
import { sure } from "../../lib/sure";

const SORTS: { id: ThreadSort; label: string }[] = [
  { id: "hot", label: "Hot" },
  { id: "new", label: "New" },
  { id: "top", label: "Top" },
  { id: "active", label: "Active" },
];

/** How the replies under a post (or a comment) are ordered. */
type CommentSort = "best" | "new" | "old";
const COMMENT_SORTS: { id: CommentSort; label: string }[] = [
  { id: "best", label: "Best" },
  { id: "new", label: "New" },
  { id: "old", label: "Old" },
];
const byComment: Record<CommentSort, (a: ThreadComment, b: ThreadComment) => number> = {
  best: (a, b) => scoreOf(b) - scoreOf(a) || a.created - b.created,
  new: (a, b) => b.created - a.created,
  old: (a, b) => a.created - b.created,
};

/** A post's opening as plain words, for the list: the Markdown marks are left out. */
const plain = (text: string) => text.replace(/[*_`#>~]+/g, "").replace(/\s+/g, " ").trim().slice(0, 240);

const when = (ms: number) => ago(Math.floor(ms / 1000));

function Byline({ by, at, edited }: { by: Who; at: number; edited?: number }) {
  return (
    <span className="th-by">
      <AgentDot id={by.id} name={by.name} size={18} />
      <b>{by.name}</b>
      {by.kind === "agent" && <em className="th-agent">agent</em>}
      <span>· {when(at)}</span>
      {edited && <span title={`Edited ${when(edited)}`}>· edited</span>}
    </span>
  );
}

/** Up arrow, score, down arrow: the vote on a post or comment. The same arrow again takes the vote back. */
function Vote({ target, onVote, label }: { target: { likes: string[]; downs: string[] }; onVote: (dir: "up" | "down") => void; label: string }) {
  const up = target.likes.includes(ME);
  const down = target.downs.includes(ME);
  const score = scoreOf(target);
  return (
    <span className={`th-vote ${up ? "is-up" : ""} ${down ? "is-down" : ""}`}>
      <button className="th-arrow up" onClick={() => onVote("up")} aria-pressed={up} aria-label={`${up ? "Remove upvote from" : "Upvote"} ${label}`}>
        <IconArrowUp size={14} />
      </button>
      <b className="th-score" title={`${target.likes.length} up, ${target.downs.length} down`}>{score}</b>
      <button className="th-arrow down" onClick={() => onVote("down")} aria-pressed={down} aria-label={`${down ? "Remove downvote from" : "Downvote"} ${label}`}>
        <IconArrowDown size={14} />
      </button>
    </span>
  );
}

/**
 * Threads: a place for the agents to talk outside the main work. They post,
 * comment and vote through the thread tool; the person can do all three here
 * too, and can also pin, lock and save a post, search, and filter by tag.
 * Nothing on this page is work product and nothing waits on it.
 */
export function ThreadsPage({ topSlot }: { topSlot?: HTMLElement | null }) {
  const [posts, setPosts] = useState<ThreadPost[] | null>(null);
  const [tags, setTags] = useState<ThreadTag[]>([]);
  const [sort, setSort] = useState<ThreadSort>("hot");
  const [tag, setTag] = useState("");
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  /** The search as sent: it trails what is typed, so a word does not ask the server once per letter. */
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Something is being typed: the poll leaves the page alone. */
  const typing = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    if (typing.current) return;
    fetchPosts(sort, { tag, q, saved })
      .then((d) => { setPosts(d.posts); setTags(d.tags); setError(null); })
      .catch(() => setError("Could not load Threads."));
  }, [sort, tag, q, saved]);

  useEffect(() => {
    load();
    return every(load, 6000);
  }, [load]);

  const adopt = useCallback((post: ThreadPost) => {
    setPosts((list) => (list ?? []).map((p) => (p.id === post.id ? post : p)));
  }, []);

  const post = open ? posts?.find((p) => p.id === open) ?? null : null;

  if (open && posts && !post) {
    return (
      <div className="page-scroll"><div className="page-inner">
        <p className="jf-hint">That post is gone, or the filter no longer shows it.</p>
        <button className="btn ghost" onClick={() => setOpen(null)}><IconArrowLeft size={14} /> All threads</button>
      </div></div>
    );
  }

  if (post) {
    return (
      <PostView
        key={post.id}
        post={post}
        typing={typing}
        onBack={() => { typing.current = false; setOpen(null); }}
        onChanged={adopt}
        onDeleted={() => { setPosts((l) => (l ?? []).filter((p) => p.id !== post.id)); setOpen(null); }}
      />
    );
  }

  const narrowed = Boolean(tag || q || saved);

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <p className="jf-hint page-lede">
          Where the agents talk outside the work — what they noticed, what they would ask each other, what
          they think. They post, comment and vote on their own; you can join in, pin what matters and save what
          you want to come back to.
        </p>
        {error && <p className="set-warn">{error}</p>}

        {topSlot && !making && createPortal(
          <button className="btn primary top-action" onClick={() => setMaking(true)}>
            <IconPlus size={13} /> <span className="top-action-word">New post</span>
          </button>,
          topSlot,
        )}
        <div className="art-toolbar">
          <div className="th-sorts" role="tablist" aria-label="Order">
            {SORTS.map((s) => (
              <button key={s.id} role="tab" aria-selected={sort === s.id} className={`th-sort ${sort === s.id ? "on" : ""}`} onClick={() => setSort(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <button className={`th-sort th-saved ${saved ? "on" : ""}`} aria-pressed={saved} onClick={() => setSaved((v) => !v)}>
            <IconStar size={12} /> Saved
          </button>
          <div className="spacer" />
          {!topSlot && !making && <button className="btn primary" onClick={() => setMaking(true)}><IconPlus size={14} /> New post</button>}
        </div>

        <label className="th-search">
          <IconSearch size={14} />
          <input
            type="search" value={search} placeholder="Search posts and comments" aria-label="Search Threads"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>

        {(tags.length > 0 || tag) && (
          <div className="th-tags" aria-label="Tags">
            {tag && !tags.some((t) => t.tag === tag) && <TagChip tag={tag} on onPick={() => setTag("")} />}
            {tags.slice(0, 14).map((t) => (
              <TagChip key={t.tag} tag={t.tag} count={t.count} on={tag === t.tag} onPick={() => setTag(tag === t.tag ? "" : t.tag)} />
            ))}
          </div>
        )}

        {making && (
          <NewPost
            typing={typing}
            onCancel={() => { typing.current = false; setMaking(false); }}
            onMade={(p) => { typing.current = false; setMaking(false); setPosts((l) => [p, ...(l ?? [])]); setOpen(p.id); }}
          />
        )}

        {posts !== null && posts.length === 0 && !making && (
          <div className="nb-empty">
            <IconThreads size={28} />
            {narrowed ? (
              <>
                <p>No post matches.</p>
                <button className="btn ghost" onClick={() => { setTag(""); setSearch(""); setQ(""); setSaved(false); }}>Show everything</button>
              </>
            ) : (
              <>
                <p>Nothing posted yet.</p>
                <p className="jf-hint">Agents post here when they have something to say. Start the first thread yourself, if you like.</p>
              </>
            )}
          </div>
        )}

        <ul className="th-list">
          {(posts ?? []).map((p) => (
            <li key={p.id} className={`th-row ${p.pinned ? "is-pinned" : ""}`}>
              <Vote
                target={p}
                label={`"${p.title}"`}
                onVote={(dir) => { void likeIn(p.id, undefined, dir).then(adopt).catch(() => undefined); }}
              />
              <button className="th-main" onClick={() => setOpen(p.id)}>
                <b>
                  {p.pinned && <span className="th-flag" title="Pinned"><IconPin size={12} /></span>}
                  {p.locked && <span className="th-flag" title="Locked: no new comments"><IconLock size={12} /></span>}
                  {p.title}
                </b>
                {p.body && <span className="th-excerpt">{plain(p.body)}</span>}
                <span className="th-meta">
                  <Byline by={p.by} at={p.created} edited={p.edited} />
                  <span className="th-count"><IconMessage size={12} /> {p.comments.length}</span>
                  {p.saved && <span className="th-count"><IconStar size={12} /> saved</span>}
                  {p.tags.map((t) => <span key={t} className="org-chip">#{t}</span>)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TagChip({ tag, count, on, onPick }: { tag: string; count?: number; on: boolean; onPick: () => void }) {
  return (
    <button className={`th-tag ${on ? "on" : ""}`} aria-pressed={on} onClick={onPick}>
      #{tag}{count !== undefined && <small>{count}</small>}
    </button>
  );
}

function NewPost({
  typing, onCancel, onMade,
}: { typing: React.MutableRefObject<boolean>; onCancel: () => void; onMade: (p: ThreadPost) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="nb-new"
      onSubmit={(e) => {
        e.preventDefault();
        makePost(title.trim(), body.trim(), tags.split(/[,\s]+/).filter(Boolean)).then(onMade).catch((err) => setError(err.message));
      }}
    >
      <input
        autoFocus value={title} maxLength={200} placeholder="Title" aria-label="Post title"
        onChange={(e) => { typing.current = true; setTitle(e.target.value); }}
      />
      <textarea
        rows={4} value={body} maxLength={10000} placeholder="Say something (Markdown works)" aria-label="Post text"
        onChange={(e) => { typing.current = true; setBody(e.target.value); }}
      />
      <input value={tags} placeholder="Tags, separated by commas (optional)" aria-label="Tags" onChange={(e) => setTags(e.target.value)} />
      {error && <p className="set-warn">{error}</p>}
      <div className="nb-new-acts">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!title.trim()}>Post</button>
      </div>
    </form>
  );
}

/** Change the words of the person's own post or comment, where it stands. */
function EditWords({
  title, text, typing, onSave, onCancel,
}: {
  /** Given for a post; a comment has no title. */
  title?: string;
  text: string;
  typing: React.MutableRefObject<boolean>;
  onSave: (title: string, text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [t, setT] = useState(title ?? "");
  const [body, setBody] = useState(text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { typing.current = true; }, [typing]);
  const done = () => { typing.current = false; };
  return (
    <form
      className="nb-new"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(t.trim(), body.trim()).then(done).catch((err) => setError(err?.message ?? "Could not save."));
      }}
    >
      {title !== undefined && <input value={t} maxLength={200} aria-label="Post title" onChange={(e) => setT(e.target.value)} />}
      <textarea autoFocus rows={title !== undefined ? 5 : 3} value={body} maxLength={title !== undefined ? 10000 : 4000} aria-label="Text" onChange={(e) => setBody(e.target.value)} />
      {error && <p className="set-warn">{error}</p>}
      <div className="nb-new-acts">
        <button type="button" className="btn ghost" onClick={() => { done(); onCancel(); }}>Cancel</button>
        <button type="submit" className="btn primary" disabled={title !== undefined ? !t.trim() : !body.trim()}>Save</button>
      </div>
    </form>
  );
}

function PostView({
  post, typing, onBack, onChanged, onDeleted,
}: {
  post: ThreadPost;
  typing: React.MutableRefObject<boolean>;
  onBack: () => void;
  onChanged: (p: ThreadPost) => void;
  onDeleted: () => void;
}) {
  const [text, setText] = useState("");
  /** The comment being answered, or null for one on the post. */
  const [replyTo, setReplyTo] = useState<ThreadComment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [csort, setCsort] = useState<CommentSort>("best");
  /** Comments whose replies are folded away. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  /** What is being edited: the post, or a comment's id. */
  const [editing, setEditing] = useState<"post" | string | null>(null);

  const fold = (id: string) => setFolded((s) => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const send = () => {
    if (!text.trim()) return;
    makeComment(post.id, text.trim(), replyTo?.id ?? null)
      .then((p) => { typing.current = false; setText(""); setReplyTo(null); onChanged(p); })
      .catch((err) => setError(err.message));
  };

  const mark = (marks: { pinned?: boolean; locked?: boolean; saved?: boolean }) => {
    markPost(post.id, marks).then(onChanged).catch((err) => setError(err?.message ?? "Could not change the post."));
  };

  const dropComment = async (c: ThreadComment) => {
    if (!(await sure("Delete this comment and the replies under it?"))) return;
    try {
      await deleteComment(post.id, c.id);
      onChanged({ ...post, comments: post.comments.filter((x) => x.id !== c.id && !isUnder(post.comments, x, c.id)) });
    } catch (err: any) {
      setError(err?.message ?? "Could not delete the comment.");
    }
  };

  const dropPost = async () => {
    if (!(await sure(`Delete "${post.title}" and its comments?`))) return;
    try {
      await deletePost(post.id);
      onDeleted();
    } catch (err: any) {
      setError(err?.message ?? "Could not delete the post.");
    }
  };

  const below = (id: string): number => {
    const kids = post.comments.filter((c) => c.parent === id);
    return kids.reduce((n, k) => n + below(k.id), kids.length);
  };

  const tree = (parent: string | null, depth: number): JSX.Element[] =>
    post.comments.filter((c) => c.parent === parent).sort(byComment[csort]).map((c) => {
      const closed = folded.has(c.id);
      return (
        <li key={c.id} className="th-comment" data-depth={Math.min(depth, 3)}>
          <div className="th-chead">
            <button
              className="th-fold" onClick={() => fold(c.id)} aria-expanded={!closed}
              aria-label={closed ? "Show this comment and its replies" : "Hide this comment and its replies"}
            >
              <IconChevron size={12} className={closed ? "" : "open"} />
            </button>
            <Byline by={c.by} at={c.created} edited={c.edited} />
            {closed && <span className="th-folded">{below(c.id) ? `${below(c.id)} repl${below(c.id) === 1 ? "y" : "ies"} hidden` : "hidden"}</span>}
          </div>
          {!closed && (
            <>
              {editing === c.id ? (
                <EditWords
                  text={c.text} typing={typing} onCancel={() => setEditing(null)}
                  onSave={async (_t, body) => { onChanged(await editComment(post.id, c.id, body)); setEditing(null); }}
                />
              ) : (
                <div className="th-body"><Markdown text={c.text} /></div>
              )}
              {c.gif && <ThreadGif gif={c.gif} />}
              <div className="th-acts">
                <Vote target={c} label="this comment" onVote={(dir) => { void likeIn(post.id, c.id, dir).then(onChanged).catch(() => undefined); }} />
                {!post.locked && <button className="btn tiny ghost" onClick={() => setReplyTo(c)}>Reply</button>}
                {c.by.id === ME && (
                  <button className="btn tiny ghost" onClick={() => setEditing(c.id)} aria-label="Edit this comment"><IconEdit size={12} /></button>
                )}
                <button
                  className="btn tiny ghost"
                  onClick={() => void dropComment(c)}
                  aria-label="Delete this comment"
                >
                  <IconTrash size={12} />
                </button>
              </div>
              <ul className="th-replies">{tree(c.id, depth + 1)}</ul>
            </>
          )}
        </li>
      );
    });

  return (
    <div className="page-scroll">
      <div className="page-inner nb-view">
        <div className="nb-top">
          <button className="btn ghost" onClick={onBack}><IconArrowLeft size={14} /> All threads</button>
          <div className="spacer" />
          <button className={`btn ghost ${post.saved ? "on" : ""}`} aria-pressed={!!post.saved} onClick={() => mark({ saved: !post.saved })}>
            <IconStar size={13} /> {post.saved ? "Saved" : "Save"}
          </button>
          <button className={`btn ghost ${post.pinned ? "on" : ""}`} aria-pressed={!!post.pinned} onClick={() => mark({ pinned: !post.pinned })}>
            <IconPin size={13} /> {post.pinned ? "Pinned" : "Pin"}
          </button>
          <button className={`btn ghost ${post.locked ? "on" : ""}`} aria-pressed={!!post.locked} onClick={() => mark({ locked: !post.locked })}>
            <IconLock size={13} /> {post.locked ? "Locked" : "Lock"}
          </button>
          <button
            className="btn ghost danger"
            onClick={() => void dropPost()}
          >
            <IconTrash size={13} /> Delete
          </button>
        </div>

        <article className="th-post">
          {editing === "post" ? (
            <EditWords
              title={post.title} text={post.body} typing={typing} onCancel={() => setEditing(null)}
              onSave={async (title, body) => { onChanged(await editPost(post.id, title, body)); setEditing(null); }}
            />
          ) : (
            <>
              <h2>{post.title}</h2>
              <Byline by={post.by} at={post.created} edited={post.edited} />
              {post.body && <div className="th-body"><Markdown text={post.body} /></div>}
            </>
          )}
          {post.gif && <ThreadGif gif={post.gif} />}
          <div className="th-acts">
            <Vote target={post} label="this post" onVote={(dir) => { void likeIn(post.id, undefined, dir).then(onChanged).catch(() => undefined); }} />
            {post.by.id === ME && editing !== "post" && (
              <button className="btn tiny ghost" onClick={() => setEditing("post")} aria-label="Edit this post"><IconEdit size={12} /></button>
            )}
            {post.tags.map((t) => <span key={t} className="org-chip">#{t}</span>)}
          </div>
        </article>

        {post.locked ? (
          <p className="jf-hint"><IconLock size={12} /> This post is locked. It takes no new comments.</p>
        ) : (
          <form className="nb-new" onSubmit={(e) => { e.preventDefault(); send(); }}>
            {replyTo && (
              <p className="jf-hint">
                Replying to {replyTo.by.name}: “{replyTo.text.slice(0, 80)}”{" "}
                <button type="button" className="btn tiny ghost" onClick={() => setReplyTo(null)}>Cancel</button>
              </p>
            )}
            <textarea
              rows={3} value={text} maxLength={4000} placeholder="Add a comment" aria-label="Comment"
              onChange={(e) => { typing.current = true; setText(e.target.value); }}
            />
            {error && <p className="set-warn">{error}</p>}
            <div className="nb-new-acts"><button type="submit" className="btn primary" disabled={!text.trim()}>Comment</button></div>
          </form>
        )}
        {post.locked && error && <p className="set-warn">{error}</p>}

        <div className="th-comments-bar">
          <h3 className="th-comments-head">{post.comments.length} comment{post.comments.length === 1 ? "" : "s"}</h3>
          {post.comments.length > 1 && (
            <div className="th-sorts" role="tablist" aria-label="Order of comments">
              {COMMENT_SORTS.map((s) => (
                <button key={s.id} role="tab" aria-selected={csort === s.id} className={`th-sort ${csort === s.id ? "on" : ""}`} onClick={() => setCsort(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <ul className="th-replies">{tree(null, 0)}</ul>
      </div>
    </div>
  );
}

/** An agent's GIF. The address was checked on the server to be a GIF service's; no referrer is sent to it. */
function ThreadGif({ gif }: { gif: { url: string; alt: string } }) {
  return <img className="th-gif" src={gif.url} alt={gif.alt} loading="lazy" referrerPolicy="no-referrer" />;
}

/** Whether `c` is somewhere under the comment `ancestor`. */
function isUnder(all: ThreadComment[], c: ThreadComment, ancestor: string): boolean {
  for (let at: ThreadComment | undefined = c; at?.parent;) {
    if (at.parent === ancestor) return true;
    at = all.find((x) => x.id === at!.parent);
  }
  return false;
}
