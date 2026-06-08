import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactElement, ReactNode } from "react";

export function reorderItems<T extends string>(items: T[], activeId: T, overId: T): T[] {
  const from = items.indexOf(activeId);
  const to = items.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function SortableList<T extends { id: string }>({
  items,
  className,
  itemClassName,
  onReorder,
  renderItem,
}: {
  items: T[];
  className?: string;
  itemClassName?: string;
  onReorder: (items: T[]) => void;
  renderItem: (item: T, state: { dragging: boolean }) => ReactNode;
}): ReactElement {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const ids = items.map((item) => item.id);

  const onDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over?.id == null ? null : String(event.over.id);
    if (!overId) return;
    const reorderedIds = reorderItems(ids, activeId, overId);
    if (reorderedIds === ids) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    onReorder(reorderedIds.map((id) => byId.get(id)).filter(Boolean) as T[]);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={className ?? "sortable-list"}>
          {items.map((item) => (
            <SortableListItem key={item.id} id={item.id} className={itemClassName}>
              {(dragging) => renderItem(item, { dragging })}
            </SortableListItem>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableListItem({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: (dragging: boolean) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      className={className ?? "sortable-list-item"}
      data-dragging={isDragging ? "true" : "false"}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      {...attributes}
      {...listeners}
    >
      {children(isDragging)}
    </div>
  );
}
