import React, { useEffect, useMemo, useState } from 'react';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { API_BASE_URL } from '../config';
import { usePlatformDialog } from '../contexts/PlatformDialogContext';

const initialColumns = [
  {
    id: 'backlog',
    title: 'Backlog',
    color: '#2563eb',
    tasks: [
      {
        id: 'task-1',
        title: 'Revisar rotas do backend',
        description: 'Confirmar integrações e rotas ativas para a operação.',
        priority: 'high',
        category: 'Backend',
        dueDate: '2026-06-21',
      },
      {
        id: 'task-2',
        title: 'Mapear fluxo de tickets',
        description: 'Definir campos minimos para atendimento.',
        priority: 'medium',
        category: 'Produto',
        dueDate: '2026-06-24',
      },
    ],
  },
  {
    id: 'doing',
    title: 'Em andamento',
    color: '#0f766e',
    tasks: [
      {
        id: 'task-3',
        title: 'Modernizar UI inicial',
        description: 'Limpar layout, estados e navegacao.',
        priority: 'medium',
        category: 'Frontend',
        dueDate: '2026-06-18',
      },
    ],
  },
  {
    id: 'review',
    title: 'Revisao',
    color: '#7c3aed',
    tasks: [
      {
        id: 'task-4',
        title: 'Validar build de producao',
        description: 'Rodar build e abrir app em navegador local.',
        priority: 'high',
        category: 'QA',
        dueDate: '2026-06-19',
      },
    ],
  },
  {
    id: 'done',
    title: 'Concluido',
    color: '#16a34a',
    tasks: [
      {
        id: 'task-5',
        title: 'Instalar dependencias do frontend',
        description: 'Restaurar node_modules para permitir build.',
        priority: 'low',
        category: 'Setup',
        dueDate: '2026-06-17',
      },
    ],
  },
];

const STORAGE_KEY = 'voltcorp:tasks-board';

const priorityMeta = {
  high: ['Alta', 'badge--danger'],
  medium: ['Media', 'badge--warning'],
  low: ['Baixa', 'badge--success'],
};

const requestJson = async (endpoint, options = {}) => {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`,
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || 'Nao foi possivel sincronizar tarefas.');
  }

  return response.status === 204 ? null : response.json();
};

const normalizeTask = (task) => ({
  ...task,
  id: String(task.id),
  apiId: task.id,
});

const buildColumnsFromTasks = (tasks) => {
  const nextColumns = initialColumns.map((column) => ({ ...column, tasks: [] }));
  tasks.map(normalizeTask).forEach((task) => {
    const column = nextColumns.find((item) => item.id === task.status) || nextColumns[0];
    column.tasks.push(task);
  });
  return nextColumns;
};

const loadStoredColumns = () => {
  if (typeof window === 'undefined') {
    return initialColumns;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    return Array.isArray(parsed) && parsed.length ? parsed : initialColumns;
  } catch (error) {
    return initialColumns;
  }
};

const findColumnByTask = (columns, taskId) =>
  columns.find((column) => column.tasks.some((task) => task.id === taskId));

const TaskCardContent = ({ task, onEdit, onDelete, canDelete = false, dragHandle }) => {
  const [priorityLabel, priorityClass] = priorityMeta[task.priority] || priorityMeta.medium;

  return (
    <>
      <div className="mb-3 flex items-start gap-2">
        {dragHandle}
        <div className="min-w-0 flex-1">
          <h4 className="m-0 text-sm font-extrabold text-slate-950">{task.title}</h4>
          <p className="m-0 mt-1 text-xs leading-5 text-slate-500">{task.description}</p>
        </div>
        {onEdit && (
          <button
            className="text-slate-400 hover:text-blue-600"
            type="button"
            onClick={() => onEdit(task)}
            title="Editar tarefa"
            aria-label={`Editar ${task.title}`}
          >
            <Pencil size={16} />
          </button>
        )}
        {canDelete && (
          <button
            className="text-slate-400 hover:text-red-600"
            type="button"
            onClick={() => onDelete(task.id)}
            title="Apagar tarefa concluída"
            aria-label="Apagar tarefa concluída"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${priorityClass}`}>{priorityLabel}</span>
        <span className="badge">{task.category}</span>
      </div>
    </>
  );
};

const SortableTask = ({ task, onEdit, onDelete, canDelete }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`task-card p-4 ${isDragging ? 'task-card--dragging' : ''}`}
    >
      <TaskCardContent
        task={task}
        onDelete={onDelete}
        onEdit={onEdit}
        canDelete={canDelete}
        dragHandle={(
          <button
            className="mt-0.5 text-slate-400 hover:text-slate-700"
            type="button"
            title="Arrastar"
            aria-label="Arrastar tarefa"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={17} />
          </button>
        )}
      />
    </article>
  );
};

const KanbanColumnDropzone = ({ column, children }) => {
  const { isOver, setNodeRef } = useDroppable({
    id: column.id,
    data: { type: 'column', columnId: column.id },
  });

  return (
    <div ref={setNodeRef} className={`task-dropzone grid flex-1 content-start gap-3 bg-slate-50 p-3 ${isOver ? 'task-dropzone--over' : ''}`}>
      {children}
    </div>
  );
};

const Kanban = () => {
  const { user } = useAuth();
  const dialog = usePlatformDialog();
  const [columns, setColumns] = useState(loadStoredColumns);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDescription, setNewTaskDescription] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState('medium');
  const [newTaskCategory, setNewTaskCategory] = useState('');
  const [targetColumn, setTargetColumn] = useState('backlog');
  const [activeTask, setActiveTask] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [editForm, setEditForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    category: 'Pessoal',
    status: 'backlog',
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const totalTasks = columns.reduce((total, column) => total + column.tasks.length, 0);

  const loadTasks = async () => {
    setLoading(true);
    try {
      const tasks = await requestJson('/tasks/');
      setColumns(buildColumnsFromTasks(tasks));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(columns));
  }, [columns]);

  const visibleColumns = useMemo(() => {
    if (!searchTerm.trim()) {
      return columns;
    }

    const term = searchTerm.toLowerCase();
    return columns.map((column) => ({
      ...column,
      tasks: column.tasks.filter(
        (task) =>
          task.title.toLowerCase().includes(term) ||
          String(task.description || '').toLowerCase().includes(term) ||
          String(task.category || '').toLowerCase().includes(term)
      ),
    }));
  }, [columns, searchTerm]);

  const handleDragStart = ({ active }) => {
    setActiveTask(active.data.current?.task || null);
  };

  const handleDragEnd = ({ active, over }) => {
    setActiveTask(null);

    if (!over || active.id === over.id) {
      return;
    }

    const previousSourceColumn = findColumnByTask(columns, active.id);
    const previousDestinationColumn =
      columns.find((column) => column.id === over.id) || findColumnByTask(columns, over.id);

    if (!previousSourceColumn || !previousDestinationColumn) {
      return;
    }

    setColumns((currentColumns) => {
      const sourceColumn = findColumnByTask(currentColumns, active.id);
      const destinationColumn =
        currentColumns.find((column) => column.id === over.id) || findColumnByTask(currentColumns, over.id);

      if (!sourceColumn || !destinationColumn) {
        return currentColumns;
      }

      const sourceIndex = sourceColumn.tasks.findIndex((task) => task.id === active.id);
      const destinationIndex = destinationColumn.tasks.findIndex((task) => task.id === over.id);

      if (sourceColumn.id === destinationColumn.id) {
        return currentColumns.map((column) =>
          column.id === sourceColumn.id
            ? {
                ...column,
                tasks: arrayMove(
                  column.tasks,
                  sourceIndex,
                  destinationIndex >= 0 ? destinationIndex : column.tasks.length - 1
                ),
              }
            : column
        );
      }

      const movingTask = sourceColumn.tasks[sourceIndex];
      return currentColumns.map((column) => {
        if (column.id === sourceColumn.id) {
          return { ...column, tasks: column.tasks.filter((task) => task.id !== active.id) };
        }

        if (column.id === destinationColumn.id) {
          const nextTasks = [...column.tasks];
          nextTasks.splice(destinationIndex >= 0 ? destinationIndex : nextTasks.length, 0, movingTask);
          return { ...column, tasks: nextTasks };
        }

        return column;
      });
    });

    if (previousSourceColumn.id !== previousDestinationColumn.id) {
      requestJson(`/tasks/${active.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: previousDestinationColumn.id }),
      }).catch((error) => {
        toast.error(error.message);
        loadTasks();
      });
    }
  };

  const handleAddTask = async (event) => {
    event.preventDefault();

    if (!newTaskTitle.trim()) {
      toast.error('Informe o titulo da tarefa.');
      return;
    }

    try {
      const createdTask = await requestJson('/tasks/', {
        method: 'POST',
        body: JSON.stringify({
          title: newTaskTitle.trim(),
          description:
            newTaskDescription.trim() ||
            `Criada por ${user?.full_name || user?.username || 'usuario'} no quadro operacional.`,
          priority: newTaskPriority,
          category: newTaskCategory.trim() || 'Pessoal',
          status: targetColumn,
        }),
      });
      const task = normalizeTask(createdTask);

      setColumns((currentColumns) =>
        currentColumns.map((column) =>
          column.id === targetColumn ? { ...column, tasks: [task, ...column.tasks] } : column
        )
      );
      setNewTaskTitle('');
      setNewTaskDescription('');
      setNewTaskPriority('medium');
      setNewTaskCategory('');
      toast.success('Tarefa adicionada.');
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleDeleteTask = async (taskId) => {
    const confirmed = await dialog.confirm({ title: "Excluir tarefa concluída?", message: "Esta tarefa será apagada definitivamente.", confirmLabel: "Excluir tarefa", danger: true });
    if (!confirmed) return;
    try {
      await requestJson(`/tasks/${taskId}`, { method: 'DELETE' });
    } catch (error) {
      toast.error(error.message);
      return;
    }

    setColumns((currentColumns) =>
      currentColumns.map((column) => ({
        ...column,
        tasks: column.tasks.filter((task) => task.id !== taskId),
      }))
    );
    toast.success('Tarefa removida.');
  };

  const openTaskEdit = (task) => {
    setEditingTask(task);
    setEditForm({
      title: task.title || '',
      description: task.description || '',
      priority: task.priority || 'medium',
      category: task.category || 'Pessoal',
      status: task.status || findColumnByTask(columns, task.id)?.id || 'backlog',
    });
  };

  const handleEditTask = async (event) => {
    event.preventDefault();
    if (!editForm.title.trim()) {
      toast.error('Informe o titulo da tarefa.');
      return;
    }
    try {
      await requestJson(`/tasks/${editingTask.apiId || editingTask.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...editForm,
          title: editForm.title.trim(),
          description: editForm.description.trim(),
          category: editForm.category.trim() || 'Pessoal',
        }),
      });
      setEditingTask(null);
      await loadTasks();
      toast.success('Tarefa atualizada.');
    } catch (error) {
      toast.error(error.message);
    }
  };
  return (

    <div className="space-y-5">
      <section className="panel p-5">
        <div className="grid gap-5">
          <div>
            <span className="badge">Tarefas pessoais</span>
            <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">Quadro de tarefas</h2>
            <p className="m-0 mt-1 text-sm text-slate-500">
              Organize tarefas pessoais por prioridade e andamento, sem vinculo com setores.
              {loading ? ' Sincronizando com a API...' : ''}
            </p>
          </div>

          <form className="task-form" onSubmit={handleAddTask}>
            <input
              className="input"
              value={newTaskTitle}
              onChange={(event) => setNewTaskTitle(event.target.value)}
              placeholder="Titulo da tarefa"
            />
            <input
              className="input"
              value={newTaskDescription}
              onChange={(event) => setNewTaskDescription(event.target.value)}
              placeholder="Descricao curta"
            />
            <select
              className="select"
              value={newTaskPriority}
              onChange={(event) => setNewTaskPriority(event.target.value)}
              aria-label="Prioridade"
            >
              <option value="high">Alta</option>
              <option value="medium">Media</option>
              <option value="low">Baixa</option>
            </select>
            <input
              className="input"
              value={newTaskCategory}
              onChange={(event) => setNewTaskCategory(event.target.value)}
              placeholder="Categoria opcional (padrão: Pessoal)"
            />
            <select className="select" value={targetColumn} onChange={(event) => setTargetColumn(event.target.value)}>
              {columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.title}
                </option>
              ))}
            </select>
            <button className="button-primary" type="submit">
              <Plus size={17} />
              Adicionar
            </button>
          </form>
        </div>
      </section>

      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
          <input
            className="input pl-10"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Buscar por titulo, categoria ou descricao"
          />
        </div>
        <span className="badge">{totalTasks} tarefas no quadro</span>
      </section>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveTask(null)}
        onDragEnd={handleDragEnd}
      >
        <section className="task-board">
          {visibleColumns.map((column) => (
            <div className="panel flex min-h-[480px] flex-col overflow-hidden" key={column.id}>
              <header className="border-b border-slate-200 p-4" style={{ boxShadow: `inset 0 3px 0 ${column.color}` }}>
                <div className="flex items-center justify-between">
                  <h3 className="m-0 text-sm font-extrabold text-slate-950">{column.title}</h3>
                  <span className="badge">{column.tasks.length}</span>
                </div>
              </header>

              <SortableContext items={column.tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                <KanbanColumnDropzone column={column}>
                  {column.tasks.length === 0 ? (
                    <div className="task-empty-drop rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500">
                      Sem tarefas
                    </div>
                  ) : (
                    column.tasks.map((task) => (
                      <SortableTask key={task.id} task={task} onEdit={openTaskEdit} onDelete={handleDeleteTask} canDelete={column.id === 'done'} />
                    ))
                  )}
                </KanbanColumnDropzone>
              </SortableContext>
            </div>
          ))}
        </section>
        <DragOverlay>
          {activeTask ? (
            <article className="task-card task-card--overlay p-4">
              <TaskCardContent
                task={activeTask}
                onDelete={() => {}}
                canDelete={false}
                dragHandle={<span className="mt-0.5 text-slate-400"><GripVertical size={17} /></span>}
              />
            </article>
          ) : null}
        </DragOverlay>
      </DndContext>
      {editingTask && (
        <div className="platform-dialog">
          <form className="platform-dialog__panel" onSubmit={handleEditTask}>
            <div className="platform-dialog__header">
              <span className="platform-dialog__icon"><Pencil /></span>
              <div><small>EDITAR TAREFA</small><h2>{editingTask.title}</h2></div>
              <button type="button" className="icon-button" onClick={() => setEditingTask(null)}>x</button>
            </div>
            <div className="platform-dialog__body grid gap-3">
              <label>
                Titulo
                <input className="input" required value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} />
              </label>
              <label>
                Descricao
                <textarea className="input" value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} />
              </label>
              <label>
                Prioridade
                <select className="select" value={editForm.priority} onChange={(event) => setEditForm({ ...editForm, priority: event.target.value })}>
                  <option value="high">Alta</option>
                  <option value="medium">Media</option>
                  <option value="low">Baixa</option>
                </select>
              </label>
              <label>
                Categoria
                <input className="input" value={editForm.category} onChange={(event) => setEditForm({ ...editForm, category: event.target.value })} />
              </label>
              <label>
                Status
                <select className="select" value={editForm.status} onChange={(event) => setEditForm({ ...editForm, status: event.target.value })}>
                  {columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
                </select>
              </label>
            </div>
            <div className="platform-dialog__actions">
              <button type="button" className="button" onClick={() => setEditingTask(null)}>Cancelar</button>
              <button className="button button--primary" type="submit">Salvar alteracoes</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default Kanban;
