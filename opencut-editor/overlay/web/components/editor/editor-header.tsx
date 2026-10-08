"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CommandIcon, FolderLibraryIcon, PlusSignIcon, Edit02Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { RenameProjectDialog } from "@/project/components/rename-project-dialog";
import { DeleteProjectDialog } from "@/project/components/delete-project-dialog";
import { ShortcutsDialog } from "@/actions/components/shortcuts-dialog";
import { ExportButton } from "./export-button";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { openProject } from "next/navigation";

/**
 * OpenCut's editor header, less its website: no feedback form, no Discord, no
 * theme toggle (Autora's theme is the window's). What stays is the project's
 * own menu and name, and Export. "Exit project" becomes a way to move between
 * projects, because the window is one editor and has no projects page.
 */
export function EditorHeader() {
	return (
		<header className="bg-background flex h-[3.4rem] items-center justify-between px-3 pt-0.5">
			<div className="flex items-center gap-1">
				<ProjectDropdown />
				<EditableProjectName />
			</div>
			<nav className="flex items-center gap-2">
				<ExportButton />
			</nav>
		</header>
	);
}

function ProjectDropdown() {
	const [openDialog, setOpenDialog] = useState<"delete" | "rename" | "shortcuts" | null>(null);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const saved = useEditor((e) => e.project.getSavedProjects());

	useEffect(() => {
		void editor.project.loadAllProjects();
	}, [editor, activeProject.metadata.name]);

	const switchTo = async (id: string | null) => {
		try {
			await editor.project.prepareExit();
		} finally {
			editor.project.closeProject();
			openProject(id);
		}
	};

	const newProject = async () => {
		try {
			await editor.project.prepareExit();
			const id = await editor.project.createNewProject({ name: "Untitled project" });
			editor.project.closeProject();
			openProject(id);
		} catch (error) {
			toast.error("Failed to create project", {
				description: error instanceof Error ? error.message : "Please try again",
			});
		}
	};

	const rename = async (name: string) => {
		try {
			if (name.trim() && name !== activeProject.metadata.name) {
				await editor.project.renameProject({ id: activeProject.metadata.id, name: name.trim() });
			}
		} catch (error) {
			toast.error("Failed to rename project", {
				description: error instanceof Error ? error.message : "Please try again",
			});
		} finally {
			setOpenDialog(null);
		}
	};

	const remove = async () => {
		try {
			const others = saved.filter((p) => p.id !== activeProject.metadata.id);
			await editor.project.deleteProjects({ ids: [activeProject.metadata.id] });
			openProject(others[0]?.id ?? null);
		} catch (error) {
			toast.error("Failed to delete project", {
				description: error instanceof Error ? error.message : "Please try again",
			});
		} finally {
			setOpenDialog(null);
		}
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon" className="p-1 rounded-sm size-8" aria-label="Projects">
						<HugeiconsIcon icon={FolderLibraryIcon} className="size-5" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="z-100 w-56">
					<DropdownMenuItem onClick={() => void newProject()} icon={<HugeiconsIcon icon={PlusSignIcon} />}>
						New project
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setOpenDialog("rename")} icon={<HugeiconsIcon icon={Edit02Icon} />}>
						Rename
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setOpenDialog("delete")} icon={<HugeiconsIcon icon={Delete02Icon} />}>
						Delete project
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setOpenDialog("shortcuts")} icon={<HugeiconsIcon icon={CommandIcon} />}>
						Shortcuts
					</DropdownMenuItem>
					{saved.length > 1 && <DropdownMenuSeparator />}
					{saved
						.filter((p) => p.id !== activeProject.metadata.id)
						.slice(0, 8)
						.map((p) => (
							<DropdownMenuItem key={p.id} onClick={() => void switchTo(p.id)}>
								<span className="truncate">{p.name}</span>
							</DropdownMenuItem>
						))}
				</DropdownMenuContent>
			</DropdownMenu>
			<RenameProjectDialog
				isOpen={openDialog === "rename"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "rename" : null)}
				onConfirm={(name) => void rename(name)}
				projectName={activeProject.metadata.name || ""}
			/>
			<DeleteProjectDialog
				isOpen={openDialog === "delete"}
				onOpenChange={(isOpen) => setOpenDialog(isOpen ? "delete" : null)}
				onConfirm={() => void remove()}
				projectNames={[activeProject.metadata.name || ""]}
			/>
			<ShortcutsDialog isOpen={openDialog === "shortcuts"} onOpenChange={(isOpen) => setOpenDialog(isOpen ? "shortcuts" : null)} />
		</>
	);
}

function EditableProjectName() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const [isEditing, setIsEditing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const originalNameRef = useRef("");
	const projectName = activeProject.metadata.name || "";

	// The name changes under the input when the agent renames the project or
	// another is opened: an uncontrolled input has to be told.
	useEffect(() => {
		if (inputRef.current && !isEditing) inputRef.current.value = projectName;
	}, [projectName, isEditing]);

	const startEditing = () => {
		if (isEditing) return;
		originalNameRef.current = projectName;
		setIsEditing(true);
		requestAnimationFrame(() => inputRef.current?.select());
	};

	const saveEdit = async () => {
		if (!inputRef.current) return;
		const newName = inputRef.current.value.trim();
		setIsEditing(false);
		if (!newName) {
			inputRef.current.value = originalNameRef.current;
			return;
		}
		if (newName !== originalNameRef.current) {
			try {
				await editor.project.renameProject({ id: activeProject.metadata.id, name: newName });
			} catch (error) {
				toast.error("Failed to rename project", {
					description: error instanceof Error ? error.message : "Please try again",
				});
			}
		}
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") {
			event.preventDefault();
			inputRef.current?.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			if (inputRef.current) {
				inputRef.current.value = originalNameRef.current;
				inputRef.current.setSelectionRange(0, 0);
			}
			setIsEditing(false);
			inputRef.current?.blur();
		}
	};

	return (
		<input
			ref={inputRef}
			type="text"
			defaultValue={projectName}
			readOnly={!isEditing}
			onClick={startEditing}
			onBlur={() => void saveEdit()}
			onKeyDown={handleKeyDown}
			aria-label="Project name"
			style={{ fieldSizing: "content" }}
			className={cn(
				"text-[0.9rem] h-8 px-2 py-1 rounded-sm bg-transparent outline-none cursor-pointer hover:bg-accent hover:text-accent-foreground",
				isEditing && "ring-1 ring-ring cursor-text hover:bg-transparent",
			)}
		/>
	);
}
