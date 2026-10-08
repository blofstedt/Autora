import { store } from "../../../autora/bridge";
import type { StorageAdapter } from "./types";

/** A file kept for the project: the bytes and what the browser knew about them. */
type Kept = { name: string; type: string; lastModified: number; blob: Blob };

/**
 * OpenCut keeps a project's media files in the browser's private file system
 * (OPFS). Here they are kept by Autora's server, through the window that holds
 * the frame, so that the agent can put the same files on the timeline.
 */
export class OPFSAdapter implements StorageAdapter<File> {
	private ns: string;

	constructor(directoryName = "media") {
		this.ns = `files/${directoryName}`;
	}

	async get(key: string): Promise<File | null> {
		const kept = await store<Kept | null>({ op: "get", ns: this.ns, key });
		return kept ? new File([kept.blob], kept.name, { type: kept.type, lastModified: kept.lastModified }) : null;
	}

	async set({ key, value: file }: { key: string; value: File }): Promise<void> {
		const kept: Kept = { name: file.name, type: file.type, lastModified: file.lastModified, blob: file };
		await store({ op: "set", ns: this.ns, key, value: kept });
	}

	async remove(key: string): Promise<void> {
		await store({ op: "remove", ns: this.ns, key });
	}

	async list(): Promise<string[]> {
		return store<string[]>({ op: "list", ns: this.ns });
	}

	async clear(): Promise<void> {
		await store({ op: "clear", ns: this.ns });
	}

	static isSupported(): boolean {
		return true;
	}
}
