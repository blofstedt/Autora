// @flow
import { t } from '@lingui/macro';
import { type StorageProvider, type FileMetadata } from '../index';
import { serializeToJSObject } from '../../Utils/Serializer';
import { getAutoraSession, gameApi } from '../../Autora/session';
import { POSITIONAL_ARGUMENTS_KEY, type AppArguments } from '../../Utils/Window';

export const AUTORA_STORAGE_NAME = 'AutoraStorage';

/** The newest revision of the game this editor knows of: the one it loaded, or the one it saved. */
let knownRevision = -1;
export const getKnownRevision = (): number => knownRevision;

/**
 * Where the game is kept: Autora's server, one project per chat. It is what the agent's game_*
 * tools work on too, so what the person changes here is what the agent sees next, and the
 * other way round. There is no dialog to choose a place: the place is the chat.
 */
export default ({
  internalName: AUTORA_STORAGE_NAME,
  name: t`Autora`,
  hiddenInOpenDialog: true,
  hiddenInSaveDialog: true,
  getFileMetadataFromAppArguments: (appArguments: AppArguments) => {
    const session = getAutoraSession();
    if (!session) return null;
    // Positional arguments are not used: the chat is the whole address of the game.
    void appArguments[POSITIONAL_ARGUMENTS_KEY];
    return { fileIdentifier: session };
  },
  createOperations: () => ({
    onOpen: async (fileMetadata: FileMetadata) => {
      const res = await fetch(gameApi('/project'), { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.project) {
        throw new Error((body && body.error) || `Autora answered ${res.status}`);
      }
      knownRevision = Number(body.rev || 0);
      return { content: body.project };
    },
    onSaveProject: async (project: gdProject, fileMetadata: FileMetadata) => {
      const content = serializeToJSObject(project);
      const res = await fetch(gameApi('/project'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: content, ifRev: knownRevision }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 409) {
        // The agent changed the game while this was being edited: its version wins, and the editor is told to take it.
        window.dispatchEvent(new CustomEvent('autora-game-conflict'));
        return { wasSaved: false, fileMetadata };
      }
      if (!res.ok) throw new Error((body && body.error) || `Autora answered ${res.status}`);
      knownRevision = Number(body.rev || knownRevision);
      return { wasSaved: true, fileMetadata: { ...fileMetadata, lastModifiedDate: Date.now() } };
    },
  }),
}: StorageProvider);
