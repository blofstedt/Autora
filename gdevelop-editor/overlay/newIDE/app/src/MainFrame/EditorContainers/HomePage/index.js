// @flow
import * as React from 'react';
import { type RenderEditorContainerPropsWithRef } from '../BaseEditor';

/**
 * GDevelop's start page is a shop window: courses, tutorials, the store, an account. None of that
 * is Autora's, so the start page is the game itself: its name, and its scenes to open. The editor
 * always has a game (the chat's), so this is the page a person sees only before the first scene opens.
 */
type Props = {| ...RenderEditorContainerPropsWithRef |};

export type HomePageEditorInterface = {|
  getProject: () => void,
  updateToolbar: () => void,
  forceUpdateEditor: () => void,
  onEventsBasedObjectChildrenEdited: (...args: any) => void,
  onSceneObjectEdited: (...args: any) => void,
  onSceneObjectsDeleted: (...args: any) => void,
  onSceneEventsModifiedOutsideEditor: (...args: any) => void,
  notifyChangesToInGameEditor: (...args: any) => void,
  switchInGameEditorIfNoHotReloadIsNeeded: () => void,
  onInstancesModifiedOutsideEditor: (...args: any) => void,
  onObjectsModifiedOutsideEditor: (...args: any) => void,
  onWillDeleteObject: (...args: any) => void,
  onObjectGroupsModifiedOutsideEditor: (...args: any) => void,
  onExtensionsModifiedOutsideEditor: (...args: any) => void,
  selectAllInsideEditor: () => void,
|};

const noop = () => {};

export const HomePage: React.ComponentType<any> = React.memo<any>(
  React.forwardRef<any, HomePageEditorInterface>(
    ({ project, onOpenLayout, setToolbar }, ref) => {
      React.useImperativeHandle(ref, () => ({
        getProject: () => project,
        updateToolbar: () => setToolbar(null),
        forceUpdateEditor: noop,
        onEventsBasedObjectChildrenEdited: noop,
        onSceneObjectEdited: noop,
        onSceneObjectsDeleted: noop,
        onSceneEventsModifiedOutsideEditor: noop,
        notifyChangesToInGameEditor: noop,
        switchInGameEditorIfNoHotReloadIsNeeded: noop,
        onInstancesModifiedOutsideEditor: noop,
        onObjectsModifiedOutsideEditor: noop,
        onWillDeleteObject: noop,
        onObjectGroupsModifiedOutsideEditor: noop,
        onExtensionsModifiedOutsideEditor: noop,
        selectAllInsideEditor: noop,
      }));
      React.useEffect(() => setToolbar(null), [setToolbar]);

      const scenes = [];
      if (project) {
        for (let i = 0; i < project.getLayoutsCount(); i++) {
          scenes.push(project.getLayoutAt(i).getName());
        }
      }
      return (
        <div className="autora-home">
          <h1>{project ? project.getName() || 'Your game' : 'Opening your game…'}</h1>
          {scenes.length > 0 && <h2>Scenes</h2>}
          <ul>
            {scenes.map(name => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() =>
                    onOpenLayout(name, {
                      openEventsEditor: false,
                      openSceneEditor: true,
                      focusWhenOpened: 'scene',
                    })
                  }
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    }
  ),
  (prevProps, nextProps) => prevProps.isActive || nextProps.isActive
);

export const renderHomePageContainer = (
  props: RenderEditorContainerPropsWithRef
): React.MixedElement => (
  // $FlowFixMe[incompatible-type]
  <HomePage
    ref={props.ref}
    project={props.project}
    isActive={props.isActive}
    setToolbar={props.setToolbar}
    onOpenLayout={props.onOpenLayout}
  />
);
