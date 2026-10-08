/**
 * Edits to GDevelop's own files (see scripts/prepare-gdevelop-editor.mjs). Each is
 * { file, find, replace }: `find` must be in the file exactly once (or `all: true`),
 * or the build fails, so a newer GDevelop that moved a line is found at build time.
 * Paths are from the root of the checkout; the editor is newIDE/app/src.
 */
const SRC = "newIDE/app/src/";

export const PATCHES = [
  // ---- One theme: Autora's (UI/Theme/DeepBlueTheme/index.js), under GDevelop's default name so nothing has to be told. ----
  {
    file: SRC + "UI/Theme/ThemeRegistry.js",
    find: `export const themes = {
  ['GDevelop default Dark']: DefaultDarkTheme,
  ['GDevelop default Light']: DefaultLightTheme,
  ['Blue Dark']: BlueDarkTheme,
  ['Nord']: NordTheme,
  ['Solarized Dark']: SolarizedDarkTheme,
  ['One Dark']: OneDarkTheme,
  ['Rosé Pine']: RosePineTheme,
  ['Deep Blue']: DeepBlueTheme,
};`,
    replace: `void [DefaultDarkTheme, DefaultLightTheme, BlueDarkTheme, NordTheme, SolarizedDarkTheme, OneDarkTheme, RosePineTheme];
export const themes = {
  ['GDevelop default Dark']: DeepBlueTheme,
};`,
  },

  // ---- No AI: the entry points. (The AI itself is stubbed in overlay/.../AiGeneration/.) ----
  {
    file: SRC + "MainFrame/index.js",
    find: `  const hideAskAi =
    !!authenticatedUser.limits &&
    !!authenticatedUser.limits.capabilities.classrooms &&
    authenticatedUser.limits.capabilities.classrooms.hideAskAi;`,
    replace: `  const hideAskAi = true;`,
  },
  {
    file: SRC + "MainFrame/TabsTitlebar.js",
    find: `  const hideAskAi =
    !!limits &&
    !!limits.capabilities.classrooms &&
    limits.capabilities.classrooms.hideAskAi;`,
    replace: `  const hideAskAi = true;`,
  },
  {
    file: SRC + "ProjectCreation/NewProjectSetupDialog.js",
    find: `  const isAskAiHiddenByClassroom =
    !!limits &&
    !!limits.capabilities.classrooms &&
    limits.capabilities.classrooms.hideAskAi;`,
    replace: `  const isAskAiHiddenByClassroom = true;`,
  },
  {
    file: SRC + "MainFrame/Preferences/PreferencesDialog.js",
    find: `  {
    name: 'ask-ai',
    label: t\`Ask AI\`,
    getIcon: ({ color, fontSize }) => (
      <RobotFaceIcon fontSize={fontSize} color={color} />
    ),
  },
`,
    replace: ``,
  },
  {
    file: SRC + "GameplayTests/GameplayTestProperties.js",
    find: `            <FlatButton
              fullWidth
              color="ai"
              leftIcon={<RobotIcon size={16} />}
              label={<Trans>Edit with AI</Trans>}
              onClick={onEditWithAi}
            />
`,
    replace: ``,
  },
  {
    file: SRC + "InGameEditorExtensionErrors/InGameEditorExtensionErrorsIndicator.js",
    find: `                <RaisedButton
                  color="ai"
                  label={<Trans>Ask the AI to fix</Trans>}
                  onClick={() => {
                    setAnchorElement(null);
                    onAskAiToFix();
                  }}
                />
`,
    replace: ``,
  },

  // ---- The game's runtime comes with the editor (dist/gdevelop-editor/GDJS), not from GDevelop's servers. ----
  {
    file: SRC + "GameEngineFinder/BrowserS3GDJSFinder.js",
    find: "  let gdjsRoot = `https://resources.gdevelop-app.com/GDJS-${getIDEVersionWithHash()}`;",
    replace: "  let gdjsRoot = new URL('./GDJS', window.location.href).href;\n  void getIDEVersionWithHash;",
  },

  // ---- The menus: what is left is what works here (the game is the chat's, kept by Autora; there is no account). ----
  {
    file: SRC + "MainFrame/MainMenu.js",
    find: `      {
        label: i18n._(t\`Create a game\`),
        accelerator: getElectronAccelerator(shortcutMap['CREATE_NEW_PROJECT']),
        onClickSendEvent: 'main-menu-create-project',
      },
      { type: 'separator' },
      {
        label: i18n._(t\`Open...\`),
        accelerator: getElectronAccelerator(shortcutMap['OPEN_PROJECT']),
        onClickSendEvent: 'main-menu-open',
      },
      {
        label: i18n._(t\`Open Recent\`),
        submenu:
          recentProjectFiles.length > 0
            ? recentProjectFiles.map(item => ({
                label: item.fileMetadata.fileIdentifier,
                onClickSendEvent: 'main-menu-open-recent',
                eventArgs: item,
              }))
            : [
                {
                  label: i18n._(t\`No recent project\`),
                  enabled: false,
                },
              ],
      },
      { type: 'separator' },
`,
    replace: ``,
  },
  {
    file: SRC + "MainFrame/MainMenu.js",
    find: `      {
        label: i18n._(t\`Save as...\`),
        accelerator: getElectronAccelerator(shortcutMap['SAVE_PROJECT_AS']),
        onClickSendEvent: 'main-menu-save-as',
        enabled: canSaveProjectAs,
      },
      {
        label: i18n._(t\`Show version history\`),
        onClickSendEvent: 'main-menu-show-version-history',
        enabled: !!project,
      },
      { type: 'separator' },
      {
        label: i18n._(t\`Invite collaborators\`),
        accelerator: getElectronAccelerator(
          shortcutMap['INVITE_COLLABORATORS']
        ),
        onClickSendEvent: 'main-menu-invite-collaborators',
        enabled: !!project,
      },
      {
        label: i18n._(t\`Export (web, iOS, Android)...\`),`,
    replace: `      { type: 'separator' },
      {
        label: i18n._(t\`Export as a web game...\`),`,
  },
  {
    file: SRC + "MainFrame/MainMenu.js",
    find: `      { type: 'separator' },
      {
        label: i18n._(t\`Close Project\`),
        accelerator: getElectronAccelerator(shortcutMap['CLOSE_PROJECT']),
        onClickSendEvent: 'main-menu-close',
        enabled: !!project,
      },
`,
    replace: ``,
  },
  {
    file: SRC + "MainFrame/MainMenu.js",
    find: `      {
        label: i18n._(t\`Open Debugger\`),
        onClickSendEvent: 'main-menu-open-debugger',
        enabled: !!project,
      },
`,
    replace: ``,
  },
  {
    file: SRC + "ProjectManager/index.js",
    find: `                    new LeafTreeViewItem(
                      new ActionTreeViewItemContent(
                        gameDashboardItemId,
                        i18n._(t\`Game Dashboard\`),
                        onOpenGamesDashboardDialog,
                        'res/icons_default/graphs_black.svg'
                      )
                    ),
`,
    replace: ``,
  },

  // ---- No telemetry: GDevelop's analytics (and Autora's page allows no connection but its own, besides). ----
  {
    file: SRC + "Utils/Analytics/EventSender.js",
    find: `  if (isDev) {
    console.info('Development build - Analytics disabled');
    return;
  }

  ensureGDevelopEditorAnalyticsReady()`,
    replace: `  if (isDev || isDev === false) {
    console.info('Analytics disabled (Autora)');
    return;
  }

  ensureGDevelopEditorAnalyticsReady()`,
  },

  {
    file: SRC + "Utils/Analytics/EventSender.js",
    find: `const ensureGDevelopEditorAnalyticsReady = async () => {
  if (gdevelopEditorAnalytics) {`,
    replace: `const ensureGDevelopEditorAnalyticsReady = async () => {
  // Autora: the analytics script is GDevelop's, loaded from its servers; it is not loaded.
  if (isDev || !isDev) return;
  if (gdevelopEditorAnalytics) {`,
  },

  // ---- No service worker: previews are served by Autora, and a worker at this page's scope would have no business here. ----
  {
    file: SRC + "ServiceWorkerSetup.js",
    find: `export function registerServiceWorker() {
`,
    replace: `export function registerServiceWorker() {
  return; // Autora: no service worker (gdevelop-editor/patches.mjs).
`,
  },

  // ---- The editor's hands, for the bridge to Autora's window (overlay/.../Autora/bridge.js). ----
  {
    file: SRC + "MainFrame/index.js",
    find: `  const previewLoading = previewLoadingRef.current;
`,
    replace: `  // Autora: the bridge to the window around this editor opens, saves and watches the game (Autora/bridge.js).
  React.useEffect(() => {
    // $FlowFixMe[prop-missing]
    window.__autoraEditor = {
      open: openFromFileMetadataWithStorageProvider,
      save: () => saveProject({ skipNewVersionWarning: true }),
      hasUnsavedChanges,
      saving: isSavingProject,
      project: state.currentProject,
    };
  });

  const previewLoading = previewLoadingRef.current;
`,
  },

  // ---- Own files go to Autora's server, not to GDevelop's cloud. ----
  {
    file: SRC + "ResourcesList/FileToCloudProjectResourceUploader.js",
    find: `        const results: UploadedProjectResourceFiles = await uploadProjectResourceFiles(
          authenticatedUser,
          cloudProjectId,
          selectedFiles,
          (current: number, total: number) => {
            setUploadProgress((current / total) * 100);
          }
        );`,
    replace: `        const results: UploadedProjectResourceFiles = await uploadResourceFilesToAutora(
          selectedFiles,
          (current: number, total: number) => {
            setUploadProgress((current / total) * 100);
          }
        );`,
  },
  {
    file: SRC + "ResourcesList/FileToCloudProjectResourceUploader.js",
    find: `import {
  type UploadedProjectResourceFiles,
  uploadProjectResourceFiles,
  PROJECT_RESOURCE_MAX_SIZE_IN_BYTES,
} from '../Utils/GDevelopServices/Project';`,
    replace: `import { type UploadedProjectResourceFiles } from '../Utils/GDevelopServices/Project';
import {
  uploadResourceFilesToAutora,
  PROJECT_RESOURCE_MAX_SIZE_IN_BYTES,
} from '../Autora/upload';`,
  },
  {
    file: SRC + "ResourcesList/FileToCloudProjectResourceUploader.js",
    find: `  const canUploadWithThisStorageProvider =
    storageProvider.internalName === 'Cloud' && !!fileMetadata;
  const isConnected = !!authenticatedUser.authenticated;`,
    replace: `  const canUploadWithThisStorageProvider =
    storageProvider.internalName === 'AutoraStorage' && !!fileMetadata;
  const isConnected = true;`,
  },
  {
    file: SRC + "ResourcesList/FileToCloudProjectResourceUploader.js",
    find: `              newResource.setOrigin('cloud-project-resource', url || '');`,
    replace: `              newResource.setOrigin('url', url || '');`,
  },
];
