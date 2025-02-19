import React, { useEffect, useRef, useState } from 'react';
import { Tooltip, Tree } from 'antd';
import { DataNode } from 'rc-tree/lib/interface';
import { TreeProps } from 'rc-tree/lib/Tree';
import cx from 'classnames';
import { inject, injectState, injectWatch, mutation, useModule } from 'slap';
import { SourcesService, SourceDisplayData } from 'services/sources';
import { ScenesService, ISceneItem, TSceneNode, isItem } from 'services/scenes';
import { SelectionService } from 'services/selection';
import { EditMenu } from 'util/menus/EditMenu';
import { WidgetDisplayData } from 'services/widgets';
import { $t } from 'services/i18n';
import { EditorCommandsService } from 'services/editor-commands';
import { EPlaceType } from 'services/editor-commands/commands/reorder-nodes';
import { AudioService } from 'services/audio';
import { StreamingService } from 'services/streaming';
import { EDismissable } from 'services/dismissables';
import { assertIsDefined, getDefined } from 'util/properties-type-guards';
import useBaseElement from './hooks';
import styles from './SceneSelector.m.less';
import Scrollable from 'components-react/shared/Scrollable';
import HelpTip from 'components-react/shared/HelpTip';
import Translate from 'components-react/shared/Translate';

interface ISourceMetadata {
  id: string;
  title: string;
  icon: string;
  isVisible: boolean;
  isLocked: boolean;
  isStreamVisible: boolean;
  isRecordingVisible: boolean;
  isFolder: boolean;
  parentId?: string;
}

class SourceSelectorModule {
  private scenesService = inject(ScenesService);
  private sourcesService = inject(SourcesService);
  private selectionService = inject(SelectionService);
  private editorCommandsService = inject(EditorCommandsService);
  private streamingService = inject(StreamingService);
  private audioService = inject(AudioService);

  sourcesTooltip = $t('The building blocks of your scene. Also contains widgets.');
  addSourceTooltip = $t('Add a new Source to your Scene. Includes widgets.');
  removeSourcesTooltip = $t('Remove Sources from your Scene.');
  openSourcePropertiesTooltip = $t('Open the Source Properties.');
  addGroupTooltip = $t('Add a Group so you can move multiple Sources at the same time.');

  state = injectState({
    expandedFoldersIds: [] as string[],
  });

  nodeRefs = {};

  callCameFromInsideTheHouse = false;

  getTreeData(nodeData: ISourceMetadata[]) {
    // recursive function for transforming SceneNode[] to a Tree format of Antd.Tree
    const getTreeNodes = (sceneNodes: ISourceMetadata[]): DataNode[] => {
      return sceneNodes.map(sceneNode => {
        if (!this.nodeRefs[sceneNode.id]) this.nodeRefs[sceneNode.id] = React.createRef();

        let children;
        if (sceneNode.isFolder) {
          children = getTreeNodes(nodeData.filter(n => n.parentId === sceneNode.id));
        }
        return {
          title: (
            <TreeNode
              title={sceneNode.title}
              id={sceneNode.id}
              isVisible={sceneNode.isVisible}
              isLocked={sceneNode.isLocked}
              toggleVisibility={() => this.toggleVisibility(sceneNode.id)}
              toggleLock={() => this.toggleLock(sceneNode.id)}
              selectiveRecordingEnabled={this.selectiveRecordingEnabled}
              isStreamVisible={sceneNode.isStreamVisible}
              isRecordingVisible={sceneNode.isRecordingVisible}
              cycleSelectiveRecording={() => this.cycleSelectiveRecording(sceneNode.id)}
              ref={this.nodeRefs[sceneNode.id]}
              onDoubleClick={() => this.sourceProperties(sceneNode.id)}
            />
          ),
          isLeaf: !children,
          key: sceneNode.id,
          switcherIcon: <i className={sceneNode.icon} />,
          children,
        };
      });
    };

    return getTreeNodes(nodeData.filter(n => !n.parentId));
  }

  get nodeData(): ISourceMetadata[] {
    return this.scene.getNodes().map(node => {
      const itemsForNode = this.getItemsForNode(node.id);
      const isVisible = itemsForNode.some(i => i.visible);
      const isLocked = itemsForNode.every(i => i.locked);
      const isRecordingVisible = itemsForNode.every(i => i.recordingVisible);
      const isStreamVisible = itemsForNode.every(i => i.streamVisible);

      const isFolder = !isItem(node);
      return {
        id: node.id,
        title: this.getNameForNode(node),
        icon: this.determineIcon(!isFolder, isFolder ? node.id : node.sourceId),
        isVisible,
        isLocked,
        isRecordingVisible,
        isStreamVisible,
        parentId: node.parentId,
        isFolder,
      };
    });
  }

  // TODO: Clean this up.  These only access state, no helpers
  getNameForNode(node: TSceneNode) {
    if (isItem(node)) {
      return this.sourcesService.state.sources[node.sourceId].name;
    }

    return node.name;
  }

  isSelected(node: TSceneNode) {
    return this.selectionService.state.selectedIds.includes(node.id);
  }

  determineIcon(isLeaf: boolean, sourceId: string) {
    if (!isLeaf) {
      return this.state.expandedFoldersIds.includes(sourceId)
        ? 'fas fa-folder-open'
        : 'fa fa-folder';
    }

    const source = this.sourcesService.state.sources[sourceId];

    if (source.propertiesManagerType === 'streamlabels') {
      return 'fas fa-file-alt';
    }

    if (source.propertiesManagerType === 'widget') {
      const widgetType = this.sourcesService.views
        .getSource(sourceId)!
        .getPropertiesManagerSettings().widgetType;

      assertIsDefined(widgetType);

      return WidgetDisplayData()[widgetType]?.icon || 'icon-error';
    }

    return SourceDisplayData()[source.type]?.icon || 'fas fa-file';
  }

  addSource() {
    if (this.scenesService.views.activeScene) {
      this.sourcesService.showShowcase();
    }
  }

  addFolder() {
    if (this.scenesService.views.activeScene) {
      let itemsToGroup: string[] = [];
      let parentId: string = '';
      if (this.selectionService.views.globalSelection.canGroupIntoFolder()) {
        itemsToGroup = this.selectionService.views.globalSelection.getIds();
        const parent = this.selectionService.views.globalSelection.getClosestParent();
        if (parent) parentId = parent.id;
      }
      this.scenesService.showNameFolder({
        itemsToGroup,
        parentId,
        sceneId: this.scenesService.views.activeScene.id,
      });
    }
  }

  showContextMenu(sceneNodeId?: string, event?: React.MouseEvent) {
    const sceneNode = this.scene.getNode(sceneNodeId || '');
    let sourceId: string = '';

    if (sceneNode) {
      sourceId = sceneNode.isFolder() ? sceneNode.getItems()[0]?.sourceId : sceneNode.sourceId;
    }

    if (sceneNode && !sceneNode.isSelected()) sceneNode.select();
    const menuOptions = sceneNode
      ? { selectedSceneId: this.scene.id, showSceneItemMenu: true, selectedSourceId: sourceId }
      : { selectedSceneId: this.scene.id };

    const menu = new EditMenu(menuOptions);
    menu.popup();
    event && event.stopPropagation();
  }

  removeItems() {
    this.selectionService.views.globalSelection.remove();
  }

  sourceProperties(nodeId: string) {
    const node =
      this.scenesService.views.getSceneNode(nodeId) ||
      this.selectionService.views.globalSelection.getNodes()[0];

    if (!node) return;

    const item = node.isItem() ? node : node.getNestedItems()[0];

    if (!item) return;

    if (item.type === 'scene') {
      this.scenesService.actions.makeSceneActive(item.sourceId);
      return;
    }

    if (!item.video) {
      this.audioService.actions.showAdvancedSettings(item.sourceId);
      return;
    }

    this.sourcesService.actions.showSourceProperties(item.sourceId);
  }

  canShowProperties(): boolean {
    if (this.activeItemIds.length === 0) return false;
    const sceneNode = this.scene.state.nodes.find(
      n => n.id === this.selectionService.state.lastSelectedId,
    );
    return !!(sceneNode && sceneNode.sceneNodeType === 'item'
      ? this.sourcesService.views.getSource(sceneNode.sourceId)?.hasProps()
      : false);
  }

  determinePlacement(info: Parameters<Required<TreeProps>['onDrop']>[0]) {
    if (!info.dropToGap && !info.node.isLeaf) return EPlaceType.Inside;
    const dropPos = info.node.pos.split('-');
    const delta = info.dropPosition - Number(dropPos[dropPos.length - 1]);

    return delta > 0 ? EPlaceType.After : EPlaceType.Before;
  }

  async handleSort(info: Parameters<Required<TreeProps>['onDrop']>[0]) {
    const targetNodes =
      this.activeItemIds.length > 0 && this.activeItemIds.includes(info.dragNode.key as string)
        ? this.activeItemIds
        : (info.dragNodesKeys as string[]);
    const nodesToDrop = this.scene.getSelection(targetNodes);
    const destNode = this.scene.getNode(info.node.key as string);
    const placement = this.determinePlacement(info);

    if (!nodesToDrop || !destNode) return;
    await this.editorCommandsService.actions.return.executeCommand(
      'ReorderNodesCommand',
      nodesToDrop,
      destNode?.id,
      placement,
    );
  }

  makeActive(info: {
    selected: boolean;
    node: DataNode;
    selectedNodes: DataNode[];
    nativeEvent: MouseEvent;
  }) {
    this.callCameFromInsideTheHouse = true;
    let ids: string[] = [info.node.key as string];

    if (info.nativeEvent.ctrlKey) {
      ids = this.activeItemIds.concat(ids);
    } else if (info.nativeEvent.shiftKey) {
      // Logic for multi-select
      const idx1 = this.nodeData.findIndex(
        i => i.id === this.activeItemIds[this.activeItemIds.length - 1],
      );
      const idx2 = this.nodeData.findIndex(i => i.id === info.node.key);
      const swapIdx = idx1 > idx2;
      ids = this.nodeData
        .map(i => i.id)
        .slice(swapIdx ? idx2 : idx1, swapIdx ? idx1 + 1 : idx2 + 1);
    }

    this.selectionService.views.globalSelection.select(ids);
  }

  @mutation()
  toggleFolder(nodeId: string) {
    if (this.state.expandedFoldersIds.includes(nodeId)) {
      this.state.expandedFoldersIds.splice(this.state.expandedFoldersIds.indexOf(nodeId), 1);
    } else {
      this.state.expandedFoldersIds.push(nodeId);
    }
  }

  canShowActions(sceneNodeId: string) {
    return this.getItemsForNode(sceneNodeId).length > 0;
  }

  get lastSelectedId() {
    return this.selectionService.state.lastSelectedId;
  }

  watchSelected = injectWatch(() => this.lastSelectedId, this.expandSelectedFolders);

  async expandSelectedFolders() {
    if (this.callCameFromInsideTheHouse) {
      this.callCameFromInsideTheHouse = false;
      return;
    }
    const node = this.scene.getNode(this.lastSelectedId);
    if (!node || this.selectionService.state.selectedIds.length > 1) return;
    this.state.setExpandedFoldersIds(
      this.state.expandedFoldersIds.concat(node.getPath().slice(0, -1)),
    );

    this.nodeRefs[this.lastSelectedId].current.scrollIntoView({ behavior: 'smooth' });
  }

  get activeItemIds() {
    return this.selectionService.state.selectedIds;
  }

  get activeItems() {
    return this.selectionService.views.globalSelection.getItems();
  }

  toggleVisibility(sceneNodeId: string) {
    const selection = this.scene.getSelection(sceneNodeId);
    const visible = !selection.isVisible();
    this.editorCommandsService.actions.executeCommand('HideItemsCommand', selection, !visible);
  }

  // Required for performance. Using Selection is too slow (Service Helpers)
  getItemsForNode(sceneNodeId: string): ISceneItem[] {
    const node = getDefined(this.scene.state.nodes.find(n => n.id === sceneNodeId));

    if (node.sceneNodeType === 'item') {
      return [node];
    }

    const children = this.scene.state.nodes.filter(n => n.parentId === sceneNodeId);
    let childrenItems: ISceneItem[] = [];

    children.forEach(c => (childrenItems = childrenItems.concat(this.getItemsForNode(c.id))));

    return childrenItems;
  }

  get selectiveRecordingEnabled() {
    return this.streamingService.state.selectiveRecording;
  }

  get streamingServiceIdle() {
    return this.streamingService.isIdle;
  }

  get replayBufferActive() {
    return this.streamingService.isReplayBufferActive;
  }

  get selectiveRecordingLocked() {
    return this.replayBufferActive || !this.streamingServiceIdle;
  }

  toggleSelectiveRecording() {
    if (this.selectiveRecordingLocked) return;
    this.streamingService.actions.setSelectiveRecording(
      !this.streamingService.state.selectiveRecording,
    );
  }

  cycleSelectiveRecording(sceneNodeId: string) {
    const selection = this.scene.getSelection(sceneNodeId);
    if (selection.isLocked()) return;
    if (selection.isStreamVisible() && selection.isRecordingVisible()) {
      selection.setRecordingVisible(false);
    } else if (selection.isStreamVisible()) {
      selection.setStreamVisible(false);
      selection.setRecordingVisible(true);
    } else {
      selection.setStreamVisible(true);
      selection.setRecordingVisible(true);
    }
  }

  toggleLock(sceneNodeId: string) {
    const selection = this.scene.getSelection(sceneNodeId);
    const locked = !selection.isLocked();
    selection.setSettings({ locked });
  }

  get scene() {
    const scene = getDefined(this.scenesService.views.activeScene);
    return scene;
  }
}

function SourceSelector() {
  const { nodeData } = useModule(SourceSelectorModule);
  return (
    <>
      <StudioControls />
      <ItemsTree />
      {nodeData.some(node => node.isFolder) && (
        <HelpTip
          title={$t('Folder Expansion')}
          dismissableKey={EDismissable.SourceSelectorFolders}
          position={{ top: '-8px', left: '102px' }}
        >
          <Translate
            message={$t(
              'Wondering how to expand your folders? Just click on the <icon></icon> icon',
            )}
          >
            <i slot="icon" className="fa fa-folder" />
          </Translate>
        </HelpTip>
      )}
    </>
  );
}

function StudioControls() {
  const {
    sourcesTooltip,
    addGroupTooltip,
    addSourceTooltip,
    removeSourcesTooltip,
    openSourcePropertiesTooltip,
    selectiveRecordingEnabled,
    selectiveRecordingLocked,
    activeItemIds,
    addSource,
    addFolder,
    removeItems,
    toggleSelectiveRecording,
    canShowProperties,
    sourceProperties,
  } = useModule(SourceSelectorModule);

  return (
    <div className={styles.topContainer} data-name="sourcesControls">
      <div className={styles.activeSceneContainer}>
        <Tooltip title={sourcesTooltip} placement="bottomLeft">
          <span className={styles.activeScene}>{$t('Sources')}</span>
        </Tooltip>
      </div>

      <Tooltip title={$t('Toggle Selective Recording')} placement="bottomRight">
        <i
          className={cx('icon-smart-record icon-button icon-button--lg', {
            active: selectiveRecordingEnabled,
            disabled: selectiveRecordingLocked,
          })}
          onClick={toggleSelectiveRecording}
        />
      </Tooltip>

      <Tooltip title={addGroupTooltip} placement="bottomRight">
        <i className="icon-add-folder icon-button icon-button--lg" onClick={addFolder} />
      </Tooltip>

      <Tooltip title={addSourceTooltip} placement="bottomRight">
        <i className="icon-add icon-button icon-button--lg" onClick={addSource} />
      </Tooltip>

      <Tooltip title={removeSourcesTooltip} placement="bottomRight">
        <i
          className={cx({
            'icon-subtract icon-button icon-button--lg': true,
            disabled: activeItemIds.length === 0,
          })}
          onClick={removeItems}
        />
      </Tooltip>

      <Tooltip title={openSourcePropertiesTooltip} placement="bottomRight">
        <i
          className={cx({ disabled: !canShowProperties(), 'icon-settings icon-button': true })}
          onClick={() => sourceProperties(activeItemIds[0])}
        />
      </Tooltip>
    </div>
  );
}

function ItemsTree() {
  const {
    nodeData,
    getTreeData,
    activeItemIds,
    expandedFoldersIds,
    selectiveRecordingEnabled,
    showContextMenu,
    makeActive,
    toggleFolder,
    handleSort,
  } = useModule(SourceSelectorModule);

  // Force a rerender when the state of selective recording changes
  const [selectiveRecordingToggled, setSelectiveRecordingToggled] = useState(false);
  useEffect(() => setSelectiveRecordingToggled(!selectiveRecordingToggled), [
    selectiveRecordingEnabled,
  ]);

  const treeData = getTreeData(nodeData);

  return (
    <Scrollable
      className={cx(styles.scenesContainer, styles.sourcesContainer)}
      style={{ height: 'calc(100% - 33px)' }}
      onContextMenu={(e: React.MouseEvent) => showContextMenu('', e)}
    >
      <Tree
        selectedKeys={activeItemIds}
        expandedKeys={expandedFoldersIds}
        onSelect={(selectedKeys, info) => makeActive(info)}
        onExpand={(selectedKeys, info) => toggleFolder(info.node.key as string)}
        onRightClick={info => showContextMenu(info.node.key as string, info.event)}
        onDrop={handleSort}
        treeData={treeData}
        draggable
        multiple
        blockNode
        showIcon
      />
    </Scrollable>
  );
}

const TreeNode = React.forwardRef(
  (
    p: {
      title: string;
      id: string;
      isLocked: boolean;
      isVisible: boolean;
      isStreamVisible: boolean;
      isRecordingVisible: boolean;
      selectiveRecordingEnabled: boolean;
      toggleVisibility: (ev: unknown) => unknown;
      toggleLock: (ev: unknown) => unknown;
      cycleSelectiveRecording: (ev: unknown) => void;
      onDoubleClick: () => void;
    },
    ref: React.RefObject<HTMLDivElement>,
  ) => {
    function selectiveRecordingMetadata() {
      if (p.isStreamVisible && p.isRecordingVisible) {
        return { icon: 'icon-smart-record', tooltip: $t('Visible on both Stream and Recording') };
      }
      return p.isStreamVisible
        ? { icon: 'icon-broadcast', tooltip: $t('Only visible on Stream') }
        : { icon: 'icon-studio', tooltip: $t('Only visible on Recording') };
    }

    return (
      <div
        className={styles.sourceTitleContainer}
        data-name={p.title}
        data-role="source"
        ref={ref}
        onDoubleClick={p.onDoubleClick}
      >
        <span className={styles.sourceTitle}>{p.title}</span>
        {p.selectiveRecordingEnabled && (
          <Tooltip title={selectiveRecordingMetadata().tooltip} placement="left">
            <i
              className={cx(selectiveRecordingMetadata().icon, { disabled: p.isLocked })}
              onClick={p.cycleSelectiveRecording}
            />
          </Tooltip>
        )}
        <i onClick={p.toggleLock} className={p.isLocked ? 'icon-lock' : 'icon-unlock'} />
        <i onClick={p.toggleVisibility} className={p.isVisible ? 'icon-view' : 'icon-hide'} />
      </div>
    );
  },
);

export default function SourceSelectorElement() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { renderElement } = useBaseElement(
    <SourceSelector />,
    { x: 200, y: 120 },
    containerRef.current,
  );

  return (
    <div
      ref={containerRef}
      data-name="SourceSelector"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {renderElement()}
    </div>
  );
}
