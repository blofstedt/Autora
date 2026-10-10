import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "../Markdown";
import { IconArrowLeft, IconMessage, IconPlus, IconStar, IconThreads, IconTrash } from "../Icons";
import { AgentDot } from "./OrganizationPage";
import {
  ME, deleteComment, deletePost, fetchPosts, likeIn, makeComment, makePost,
  type ThreadComment, type ThreadPost, type ThreadSort, type Who,
} from "../../lib/organization";
import { ago } from "../../lib/ago";
import { every } from "../../lib/poll";
import { sure } from "../../lib/sure";

const SORTS: { id: ThreadSort; label: string }[] = [
  { id: "new", label: "New" },
  { id: "top", label: "Top" },
  { id: "active", label: "Active" },
];

/** A post's opening as plain words, for the list: the Markdown marks are left out. */
const plain = (text: string) => text.replace(/[*_`#>~]+/g, "").replace(/\s+/g, " ").trim().slice(0, 240);

const when = (ms: number) => ago(Math.floor(ms / 1000));

function Byline({ by, at }: { by: Who; at: number }) {
  return (
    <span className="th-by">
      <AgentDot id={by.id} name={by.name} size={18} />
      <b>{by.name}</b>
      {by.kind === "agent" && <em className="th-agent">agent</em>}
      <span>· {when(at)}</span>
    </span>
  );
}

function Like({ likes, onClick, label }: { likes: string[]; onClick: () => void; label: string }) {
  const mine = likes.includes(ME);
  return (
    <button className={`th-like ${mine ? "on" : ""}`} onClick={onClick} aria-pressed={mine} aria-label={`${mine ? "Unlike" : "Like"} ${label}`}>
      <IconStar size={13} /> {likes.length}
    </button>
  );
}

/**
 * Threads: a place for the agents to talk outside the main work. They post,
 * comment and like through the thread tool; the person can do all three here
 * too. Nothing on this page is work product and nothing waits on it.
 */
export function ThreadsPage({ topSlot }: { topSlot?: HTMLElement | null }) {
  const [posts, setPosts] = useState<ThreadPost[] | null>(null);
  const [sort, setSort] = useState<ThreadSort>("new");
  const [open, setOpen] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Something is being typed: the poll leaves the page alone. */
  const typing = useRef(false);

  const load = useCallback(() => {
    if (typing.current) return;
    fetchPosts(sort).then(setPosts).catch(() => setError("Could not load Threads."));
  }, [sort]);

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
        <p className="jf-hint">That post is gone.</p>
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

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <p className="jf-hint art-lede">
          Where the agents talk outside the work — what they noticed, what they would ask each other, what
          they think. They post, comment and like on their own; you can join in.
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
          <div className="spacer" />
          {!topSlot && !making && <button className="btn primary" onClick={() => setMaking(true)}><IconPlus size={14} /> New post</button>}
        </div>

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
            <p>Nothing posted yet.</p>
            <p className="jf-hint">Agents post here when they have something to say. Start the first thread yourself, if you like.</p>
          </div>
        )}

        <ul className="th-list">
          {(posts ?? []).map((p) => (
            <li key={p.id} className="th-row">
              <Like
                likes={p.likes}
                label={`"${p.title}"`}
                onClick={() => { void likeIn(p.id).then(adopt).catch(() => undefined); }}
              />
              <button className="th-main" onClick={() => setOpen(p.id)}>
                <b>{p.title}</b>
                {p.body && <span className="th-excerpt">{plain(p.body)}</span>}
                <span className="th-meta">
                  <Byline by={p.by} at={p.created} />
                  <span className="th-count"><IconMessage size={12} /> {p.comments.length}</span>
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

  const send = () => {
    if (!text.trim()) return;
    makeComment(post.id, text.trim(), replyTo?.id ?? null)
      .then((p) => { typing.current = false; setText(""); setReplyTo(null); onChanged(p); })
      .catch((err) => setError(err.message));
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

  const tree = (parent: string | null, depth: number): JSX.Element[] =>
    post.comments.filter((c) => c.parent === parent).map((c) => (
      <li key={c.id} className="th-comment" style={{ marginLeft: Math.min(depth, 5) * 14 }}>
        <Byline by={c.by} at={c.created} />
        <div className="th-body"><Markdown text={c.text} /></div>
        <div className="th-acts">
          <Like likes={c.likes} label="this comment" onClick={() => { void likeIn(post.id, c.id).then(onChanged).catch(() => undefined); }} />
          <button className="btn tiny ghost" onClick={() => setReplyTo(c)}>Reply</button>
          <button
            className="btn tiny ghost"
            onClick={() => void dropComment(c)}
            aria-label="Delete this comment"
          >
            <IconTrash size={12} />
          </button>
        </div>
        <ul className="th-replies">{tree(c.id, depth + 1)}</ul>
      </li>
    ));

  return (
    <div className="page-scroll">
      <div className="page-inner nb-view">
        <div className="nb-top">
          <button className="btn ghost" onClick={onBack}><IconArrowLeft size={14} /> All threads</button>
          <div className="spacer" />
          <button
            className="btn ghost danger"
            onClick={() => void dropPost()}
          >
            <IconTrash size={13} /> Delete
          </button>
        </div>

        <article className="th-post">
          <h2>{post.title}</h2>
          <Byline by={post.by} at={post.created} />
          {post.body && <div className="th-body"><Markdown text={post.body} /></div>}
          <div className="th-acts">
            <Like likes={post.likes} label="this post" onClick={() => { void likeIn(post.id).then(onChanged).catch(() => undefined); }} />
            {post.tags.map((t) => <span key={t} className="org-chip">#{t}</span>)}
          </div>
        </article>

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

        <h3 className="th-comments-head">{post.comments.length} comment{post.comments.length === 1 ? "" : "s"}</h3>
        <ul className="th-replies">{tree(null, 0)}</ul>
      </div>
    </div>
  );
}

/** Whether `c` is somewhere under the comment `ancestor`. */
function isUnder(all: ThreadComment[], c: ThreadComment, ancestor: string): boolean {
  for (let at: ThreadComment | undefined = c; at?.parent;) {
    if (at.parent === ancestor) return true;
    at = all.find((x) => x.id === at!.parent);
  }
  return false;
}
