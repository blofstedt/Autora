// @flow
import { Trans } from '@lingui/macro';
import * as React from 'react';
import { I18n } from '@lingui/react';
import Dialog from '../../UI/Dialog';
import FlatButton from '../../UI/FlatButton';
import ErrorBoundary from '../../UI/ErrorBoundary';
import AuthenticatedUserContext from '../../Profile/AuthenticatedUserContext';
import EventsFunctionsExtensionsContext from '../../EventsFunctionsExtensionsLoader/EventsFunctionsExtensionsContext';
import { type ExportPipeline } from '../ExportPipeline.flow';
import { type FileMetadata, type StorageProvider } from '../../ProjectsStorage';
import type { GamesList } from '../../GameDashboard/UseGamesList';
import { useGameAndBuildsManager } from '../../Utils/UseGameAndBuildsManager';
import ExportLauncher from './ExportLauncher';

/**
 * GDevelop's Share dialog offers its own hosting (gd.games), builds made on its servers (desktop,
 * Android, iOS) and inviting collaborators to a cloud project. None of that is Autora's, so this
 * dialog has the one thing that works without a server: the game as a web game, a folder in a
 * .zip that plays in any browser and goes to any host (itch.io, a web server...).
 * The types are GDevelop's: the rest of the editor still names them.
 */
export type ShareTab = 'invite' | 'publish';
export type ExporterSection = 'browser' | 'desktop' | 'android' | 'ios';
export type ExporterSubSection = 'online' | 'offline' | 'facebook';
export type ExporterKey =
  | 'onlinewebexport'
  | 'onlineelectronexport'
  | 'onlinecordovaexport'
  | 'onlinecordovaiosexport'
  | 'webexport'
  | 'facebookinstantgamesexport'
  | 'electronexport'
  | 'cordovaexport';

export type Exporter = {|
  name: React.Node,
  tabName: React.Node,
  helpPage: string,
  disabled?: boolean,
  key: ExporterKey,
  exportPipeline: ExportPipeline<any, any, any, any, any>,
|};

export type ShareDialogWithoutExportsProps = {|
  project: ?gdProject,
  onSaveProject: () => Promise<?FileMetadata>,
  isSavingProject: boolean,
  onClose: () => void,
  onChangeSubscription: () => void,
  initialTab: ?ShareTab,
  fileMetadata: ?FileMetadata,
  storageProvider: StorageProvider,
  gamesList: GamesList,
|};

type Props = {|
  ...ShareDialogWithoutExportsProps,
  automatedExporters: ?Array<Exporter>,
  manualExporters: ?Array<Exporter>,
  onlineWebExporter: Exporter,
  allExportersRequireOnline?: boolean,
|};

const ShareDialog = ({
  project,
  onSaveProject,
  isSavingProject,
  onClose,
  onChangeSubscription,
  manualExporters,
  gamesList,
}: Props) => {
  const authenticatedUser = React.useContext(AuthenticatedUserContext);
  const eventsFunctionsExtensionsState = React.useContext(
    EventsFunctionsExtensionsContext
  );
  const [isNavigationDisabled, setIsNavigationDisabled] = React.useState<
    boolean
  >(false);
  const gameAndBuildsManager = useGameAndBuildsManager({
    project,
    onGameRegistered: gamesList.fetchGames,
  });
  const exporter = (manualExporters || []).find(
    candidate => candidate.key === 'webexport'
  );

  if (!project || !exporter) return null;
  return (
    <Dialog
      id="export-dialog"
      maxWidth={'md'}
      title={<Trans>Export your game</Trans>}
      actions={[
        <FlatButton
          label={<Trans>Close</Trans>}
          key="close"
          primary={false}
          onClick={onClose}
          disabled={isNavigationDisabled}
        />,
      ]}
      onRequestClose={onClose}
      open
      flexColumnBody
    >
      <I18n>
        {({ i18n }) => (
          <ExportLauncher
            i18n={i18n}
            authenticatedUser={authenticatedUser}
            eventsFunctionsExtensionsState={eventsFunctionsExtensionsState}
            exportPipeline={exporter.exportPipeline}
            project={project}
            onSaveProject={onSaveProject}
            isSavingProject={isSavingProject}
            gameAndBuildsManager={gameAndBuildsManager}
            onChangeSubscription={onChangeSubscription}
            setIsNavigationDisabled={setIsNavigationDisabled}
          />
        )}
      </I18n>
    </Dialog>
  );
};

const ShareDialogWithErrorBoundary = (props: Props): React.Node => (
  <ErrorBoundary
    componentTitle={<Trans>Share dialog</Trans>}
    scope="export-and-share"
    onClose={props.onClose}
  >
    <ShareDialog {...props} />
  </ErrorBoundary>
);

export default ShareDialogWithErrorBoundary;
