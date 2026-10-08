// @flow
import * as React from 'react';
import MainFrame from './MainFrame';
import Window from './Utils/Window';
import ShareDialog from './ExportAndShare/ShareDialog';
import Authentication from './Utils/GDevelopServices/Authentication';
import './UI/icomoon-font.css'; // Styles for Icomoon font.
import './Autora/autora.css';

import browserResourceSources from './ResourcesList/BrowserResourceSources';
import BrowserSWPreviewLauncher from './ExportAndShare/BrowserExporters/BrowserSWPreviewLauncher';
import { browserManualExporters, browserOnlineWebExporter } from './ExportAndShare/BrowserExporters';
import makeExtensionsLoader from './JsExtensionsLoader/BrowserJsExtensionsLoader';
import ObjectsEditorService from './ObjectEditor/ObjectsEditorService';
import ObjectsRenderingService from './ObjectsRendering/ObjectsRenderingService';
import { makeBrowserSWEventsFunctionCodeWriter } from './EventsFunctionsExtensionsLoader/CodeWriters/BrowserSWEventsFunctionCodeWriter';
import Providers from './MainFrame/Providers';
import ProjectStorageProviders from './ProjectsStorage/ProjectStorageProviders';
import AutoraStorageProvider from './ProjectsStorage/AutoraStorageProvider';
import BrowserEventsFunctionsExtensionOpener from './EventsFunctionsExtensionsLoader/Storage/BrowserEventsFunctionsExtensionOpener';
import BrowserEventsFunctionsExtensionWriter from './EventsFunctionsExtensionsLoader/Storage/BrowserEventsFunctionsExtensionWriter';
import BrowserLoginProvider from './LoginProvider/BrowserLoginProvider';
import { ensureBrowserSWPreviewSession } from './ExportAndShare/BrowserExporters/BrowserSWPreviewLauncher/BrowserSWPreviewIndexedDB';
import { startAutoraBridge } from './Autora/bridge';

// The game's files are public addresses or files Autora's server keeps, so there is nothing to download or move when a game opens or is saved.
const AutoraResourceFetcher = {
  fetchAllProjectResources: async () => ({ erroredResources: [] }),
};
const AutoraResourceMover = {
  moveAllProjectResources: async () => ({ erroredResources: [] }),
};

/**
 * GDevelop's editor as Autora's game window: the same editor, with one place to keep a game (the
 * chat's, on Autora's server), no account, no cloud, no shop and no AI (Autora is the one that
 * helps). What was removed, and how, is in docs/MODULES.md and gdevelop-editor/patches.mjs.
 */
export const create = (authentication: Authentication): React.Node => {
  Window.setUpContextMenu();
  const loginProvider = new BrowserLoginProvider(authentication.auth);
  authentication.setLoginProvider(loginProvider);
  ensureBrowserSWPreviewSession();
  startAutoraBridge();

  const appArguments = Window.getArguments();

  return (
    <Providers
      authentication={authentication}
      disableCheckForUpdates
      makeEventsFunctionCodeWriter={makeBrowserSWEventsFunctionCodeWriter}
      // $FlowFixMe[incompatible-type]
      // $FlowFixMe[incompatible-exact]
      eventsFunctionsExtensionWriter={BrowserEventsFunctionsExtensionWriter}
      // $FlowFixMe[incompatible-type]
      // $FlowFixMe[incompatible-exact]
      eventsFunctionsExtensionOpener={BrowserEventsFunctionsExtensionOpener}
    >
      {({ i18n }) => (
        <ProjectStorageProviders
          appArguments={appArguments}
          storageProviders={[AutoraStorageProvider]}
          defaultStorageProvider={AutoraStorageProvider}
        >
          {({
            getStorageProviderOperations,
            getStorageProviderResourceOperations,
            storageProviders,
            initialFileMetadataToOpen,
            getStorageProvider,
          }) => (
            <MainFrame
              i18n={i18n}
              useCliCommandRunner={() => {}}
              renderPreviewLauncher={(props, ref) => (
                // $FlowFixMe[incompatible-type]
                <BrowserSWPreviewLauncher {...props} ref={ref} />
              )}
              renderShareDialog={props => (
                <ShareDialog
                  project={props.project}
                  onSaveProject={props.onSaveProject}
                  isSavingProject={props.isSavingProject}
                  onChangeSubscription={props.onChangeSubscription}
                  onClose={props.onClose}
                  automatedExporters={null}
                  manualExporters={browserManualExporters.filter(
                    exporter => exporter.key === 'webexport'
                  )}
                  onlineWebExporter={browserOnlineWebExporter}
                  allExportersRequireOnline={false}
                  fileMetadata={props.fileMetadata}
                  storageProvider={props.storageProvider}
                  initialTab={props.initialTab}
                  gamesList={props.gamesList}
                />
              )}
              storageProviders={storageProviders}
              resourceMover={AutoraResourceMover}
              resourceFetcher={AutoraResourceFetcher}
              getStorageProviderOperations={getStorageProviderOperations}
              getStorageProviderResourceOperations={
                getStorageProviderResourceOperations
              }
              getStorageProvider={getStorageProvider}
              resourceSources={browserResourceSources}
              resourceExternalEditors={[]}
              extensionsLoader={makeExtensionsLoader({
                objectsEditorService: ObjectsEditorService,
                objectsRenderingService: ObjectsRenderingService,
                filterExamples: !Window.isDev(),
              })}
              initialFileMetadataToOpen={initialFileMetadataToOpen}
              initialExampleSlugToOpen={null}
            />
          )}
        </ProjectStorageProviders>
      )}
    </Providers>
  );
};
