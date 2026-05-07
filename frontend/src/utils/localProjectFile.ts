import type { BoardKind, LanguageMode } from '../types/board';
import type { Wire } from '../types/wire';
import { BOARD_KIND_LABELS } from '../types/board';
import { useEditorStore, type WorkspaceFile } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useVfsStore, type VfsNode } from '../store/useVfsStore';

const LOCAL_PROJECT_VERSION = 1;
const BOARD_RELOAD_SETTLE_MS = 500;

type LocalComponent = {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
};

type LocalBoard = {
  id: string;
  boardKind: BoardKind;
  x: number;
  y: number;
  activeFileGroupId: string;
  languageMode: LanguageMode;
};

type LocalFile = {
  id: string;
  name: string;
  content: string;
  modified: boolean;
};

type LocalVfsBoard = {
  tree: Record<string, VfsNode>;
  rootId: string;
};

export type LocalProjectFile = {
  format: 'velxio-project';
  version: number;
  savedAt: string;
  name: string;
  simulator: {
    boards: LocalBoard[];
    activeBoardId: string | null;
    components: LocalComponent[];
    wires: Wire[];
  };
  editor: {
    fileGroups: Record<string, LocalFile[]>;
    activeGroupId: string;
    activeGroupFileId: Record<string, string>;
    openGroupFileIds: Record<string, string[]>;
  };
  raspberryPiVfs?: {
    boards: Record<string, LocalVfsBoard>;
    selectedNodeId: Record<string, string | null>;
  };
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toLocalFile(file: WorkspaceFile): LocalFile {
  return {
    id: file.id,
    name: file.name,
    content: file.content,
    modified: file.modified,
  };
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'velxio-project';
}

function remapBoardScopedGroupId(groupId: string, idRemap: Map<string, string>): string {
  const oldBoardId = groupId.startsWith('group-') ? groupId.slice('group-'.length) : '';
  return oldBoardId && idRemap.has(oldBoardId) ? `group-${idRemap.get(oldBoardId)}` : groupId;
}

function normalizeEditorSelection(
  fileGroups: Record<string, WorkspaceFile[]>,
  activeGroupId: string,
  activeGroupFileId: Record<string, string>,
  openGroupFileIds: Record<string, string[]>,
) {
  const normalizedActive: Record<string, string> = {};
  const normalizedOpen: Record<string, string[]> = {};

  for (const [groupId, files] of Object.entries(fileGroups)) {
    const validFileIds = new Set(files.map((file) => file.id));
    const fallbackFileId = files[0]?.id ?? '';
    const savedActive = activeGroupFileId[groupId];
    const activeFileId = savedActive && validFileIds.has(savedActive) ? savedActive : fallbackFileId;
    const openFileIds = (openGroupFileIds[groupId] ?? []).filter((id) => validFileIds.has(id));

    if (activeFileId) normalizedActive[groupId] = activeFileId;
    normalizedOpen[groupId] =
      openFileIds.length > 0
        ? openFileIds
        : activeFileId
          ? [activeFileId]
          : [];
  }

  const activeFiles = fileGroups[activeGroupId] ?? [];
  const activeFileId = normalizedActive[activeGroupId] ?? activeFiles[0]?.id ?? '';

  return {
    activeFileId,
    activeGroupFileId: normalizedActive,
    openFileIds:
      normalizedOpen[activeGroupId] ??
      (activeFileId ? [activeFileId] : []),
    openGroupFileIds: normalizedOpen,
  };
}

function isBoardKind(value: unknown): value is BoardKind {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(BOARD_KIND_LABELS, value)
  );
}

function normalizeProject(input: unknown): LocalProjectFile {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid Velxio project file.');
  }
  const project = input as Partial<LocalProjectFile>;
  if (project.format !== 'velxio-project') {
    throw new Error('This is not a Velxio project file.');
  }
  if (project.version !== LOCAL_PROJECT_VERSION) {
    throw new Error(`Unsupported Velxio project version: ${String(project.version)}`);
  }
  if (!project.simulator || !project.editor) {
    throw new Error('Project file is missing simulator or editor data.');
  }
  if (!Array.isArray(project.simulator.boards)) {
    throw new Error('Project file has invalid boards data.');
  }
  for (const board of project.simulator.boards) {
    if (!isBoardKind(board.boardKind)) {
      throw new Error(`Unsupported board kind: ${String(board.boardKind)}`);
    }
  }
  return project as LocalProjectFile;
}

export function createLocalProjectSnapshot(name = 'Velxio Project'): LocalProjectFile {
  const sim = useSimulatorStore.getState();
  const editor = useEditorStore.getState();
  const vfs = useVfsStore.getState();

  const fileGroups = Object.fromEntries(
    Object.entries(editor.fileGroups).map(([groupId, files]) => [groupId, files.map(toLocalFile)]),
  );

  return {
    format: 'velxio-project',
    version: LOCAL_PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    name,
    simulator: {
      boards: sim.boards.map((board) => ({
        id: board.id,
        boardKind: board.boardKind,
        x: board.x,
        y: board.y,
        activeFileGroupId: board.activeFileGroupId,
        languageMode: board.languageMode ?? 'arduino',
      })),
      activeBoardId: sim.activeBoardId,
      components: cloneJson(sim.components),
      wires: cloneJson(sim.wires),
    },
    editor: {
      fileGroups,
      activeGroupId: editor.activeGroupId,
      activeGroupFileId: cloneJson(editor.activeGroupFileId),
      openGroupFileIds: cloneJson(editor.openGroupFileIds),
    },
    raspberryPiVfs: {
      boards: cloneJson(vfs.boards),
      selectedNodeId: cloneJson(vfs.selectedNodeId),
    },
  };
}

export function downloadLocalProject(project: LocalProjectFile): string {
  const filename = `${sanitizeFilename(project.name)}.velxio.json`;
  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return filename;
}

export async function readLocalProjectFile(file: File): Promise<LocalProjectFile> {
  const text = await file.text();
  try {
    return normalizeProject(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('Project file is not valid JSON.');
    }
    throw err;
  }
}

export async function loadLocalProject(project: LocalProjectFile): Promise<void> {
  const sim = useSimulatorStore.getState();
  const currentBoardIds = sim.boards.map((board) => board.id);
  currentBoardIds.forEach((boardId) => sim.removeBoard(boardId));
  if (currentBoardIds.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, BOARD_RELOAD_SETTLE_MS));
  }

  const idRemap = new Map<string, string>();
  for (const board of project.simulator.boards) {
    const createdId = useSimulatorStore.getState().addBoard(board.boardKind, board.x, board.y);
    idRemap.set(board.id, createdId);
    useSimulatorStore.getState().updateBoard(createdId, {
      languageMode: board.languageMode,
      compiledProgram: null,
      serialOutput: '',
      serialBaudRate: 0,
      serialMonitorOpen: false,
      activeFileGroupId: `group-${createdId}`,
    });
  }

  const remapComponentId = (id: string): string => idRemap.get(id) ?? id;
  const wires = project.simulator.wires.map((wire) => ({
    ...wire,
    start: { ...wire.start, componentId: remapComponentId(wire.start.componentId) },
    end: { ...wire.end, componentId: remapComponentId(wire.end.componentId) },
    waypoints: wire.waypoints ?? [],
  }));

  useSimulatorStore.setState({
    components: cloneJson(project.simulator.components),
    wires,
    selectedWireId: null,
    wireInProgress: null,
  });

  const remappedFileGroups: Record<string, WorkspaceFile[]> = Object.fromEntries(
    Object.entries(project.editor.fileGroups).map(([groupId, files]) => {
      const newGroupId = remapBoardScopedGroupId(groupId, idRemap);
      return [
        newGroupId,
        files.map((file) => ({
          id: file.id,
          name: file.name,
          content: file.content,
          modified: file.modified,
        })),
      ];
    }),
  );

  const remapGroupMap = (map: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(map).map(([groupId, fileId]) => {
        const newGroupId = remapBoardScopedGroupId(groupId, idRemap);
        return [newGroupId, fileId];
      }),
    );

  const remapOpenGroupMap = (map: Record<string, string[]>): Record<string, string[]> =>
    Object.fromEntries(
      Object.entries(map).map(([groupId, fileIds]) => {
        const newGroupId = remapBoardScopedGroupId(groupId, idRemap);
        return [newGroupId, fileIds];
      }),
    );

  const activeBoardId =
    (project.simulator.activeBoardId && idRemap.get(project.simulator.activeBoardId)) ??
    useSimulatorStore.getState().boards[0]?.id ??
    null;
  const activeGroupId = activeBoardId ? `group-${activeBoardId}` : project.editor.activeGroupId;
  const activeGroupFiles = remappedFileGroups[activeGroupId] ?? [];
  const activeGroupFileId = remapGroupMap(project.editor.activeGroupFileId);
  const openGroupFileIds = remapOpenGroupMap(project.editor.openGroupFileIds);
  const editorSelection = normalizeEditorSelection(
    remappedFileGroups,
    activeGroupId,
    activeGroupFileId,
    openGroupFileIds,
  );

  useEditorStore.setState({
    fileGroups: remappedFileGroups,
    activeGroupId,
    activeGroupFileId: editorSelection.activeGroupFileId,
    openGroupFileIds: editorSelection.openGroupFileIds,
    files: activeGroupFiles,
    activeFileId: editorSelection.activeFileId,
    openFileIds: editorSelection.openFileIds,
    codeChangedSinceLastCompile: true,
  });

  const vfs = project.raspberryPiVfs;
  const remappedVfsBoards = vfs?.boards
    ? Object.fromEntries(
        Object.entries(vfs.boards).map(([boardId, boardVfs]) => [
          idRemap.get(boardId) ?? boardId,
          boardVfs,
        ]),
      )
    : {};
  const remappedSelectedNodeId = vfs?.selectedNodeId
    ? Object.fromEntries(
        Object.entries(vfs.selectedNodeId).map(([boardId, nodeId]) => [
          idRemap.get(boardId) ?? boardId,
          nodeId,
        ]),
      )
    : {};
  useVfsStore.setState({
    boards: cloneJson(remappedVfsBoards),
    selectedNodeId: cloneJson(remappedSelectedNodeId),
  });

  if (activeBoardId) {
    useSimulatorStore.getState().setActiveBoardId(activeBoardId);
  } else {
    useSimulatorStore.setState({ activeBoardId: null, running: false, compiledHex: null });
  }
  useSimulatorStore.getState().recalculateAllWirePositions();
  useProjectStore.getState().clearCurrentProject();
}
