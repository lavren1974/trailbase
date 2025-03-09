import {
  type ResourceFetcherInfo,
  For,
  Match,
  Switch,
  createMemo,
  createEffect,
  createResource,
  createSignal,
} from "solid-js";
import { createStore, type Store, type SetStoreFunction } from "solid-js/store";
import { useSearchParams } from "@solidjs/router";
import type {
  ColumnDef,
  PaginationState,
  CellContext,
} from "@tanstack/solid-table";
import { createColumnHelper } from "@tanstack/solid-table";
import type { DialogTriggerProps } from "@kobalte/core/dialog";
import { asyncBase64Encode } from "trailbase";

import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { TbRefresh, TbTable, TbTrash } from "solid-icons/tb";

import {
  SchemaDialog,
  DebugSchemaDialogButton,
} from "@/components/tables/SchemaDownload";
import { CreateAlterTableForm } from "@/components/tables/CreateAlterTable";
import { CreateAlterIndexForm } from "@/components/tables/CreateAlterIndex";
import {
  DataTable,
  defaultPaginationState,
  safeParseInt,
} from "@/components/Table";
import { FilterBar } from "@/components/FilterBar";
import { DestructiveActionButton } from "@/components/DestructiveActionButton";
import { IconButton } from "@/components/IconButton";
import { InsertUpdateRowForm } from "@/components/tables/InsertUpdateRow";
import { RecordApiSettingsForm } from "@/components/tables/RecordApiSettings";
import { SafeSheet } from "@/components/SafeSheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { createConfigQuery, invalidateConfig } from "@/lib/config";
import { type FormRow, RowData } from "@/lib/convert";
import { adminFetch } from "@/lib/fetch";
import { urlSafeBase64ToUuid } from "@/lib/utils";
import { RecordApiConfig } from "@proto/config";
import { dropTable, dropIndex } from "@/lib/table";
import { deleteRows, fetchRows, type FetchArgs } from "@/lib/row";
import {
  findPrimaryKeyColumnIndex,
  getForeignKey,
  isFileUploadColumn,
  isFileUploadsColumn,
  isJSONColumn,
  isNotNull,
  isUUIDv7Column,
  hiddenTable,
  tableType,
  tableSatisfiesRecordApiRequirements,
  viewSatisfiesRecordApiRequirements,
  type TableType,
} from "@/lib/schema";

import type { Column } from "@bindings/Column";
import type { ListRowsResponse } from "@bindings/ListRowsResponse";
import type { ListSchemasResponse } from "@bindings/ListSchemasResponse";
import type { Table } from "@bindings/Table";
import type { TableIndex } from "@bindings/TableIndex";
import type { TableTrigger } from "@bindings/TableTrigger";
import type { View } from "@bindings/View";

type FileUpload = {
  id: string;
  filename: string | undefined;
  content_type: string | undefined;
  mime_type: string | string;
};

type FileUploads = FileUpload[];

function rowDataToRow(columns: Column[], row: RowData): FormRow {
  const result: FormRow = {};
  for (let i = 0; i < row.length; ++i) {
    result[columns[i].name] = row[i];
  }
  return result;
}

function renderCell(
  context: CellContext<RowData, unknown>,
  tableName: string,
  columns: Column[],
  pkIndex: number,
  cell: {
    col: Column;
    isUUIDv7: boolean;
    isJSON: boolean;
    isFile: boolean;
    isFiles: boolean;
  },
): unknown {
  const value = context.getValue();
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "string") {
    if (cell.isUUIDv7) {
      return urlSafeBase64ToUuid(value);
    }

    const imageMime = (f: FileUpload) => {
      const mime = f.mime_type;
      return mime === "image/jpeg" || mime === "image/png";
    };

    if (cell.isFile) {
      const fileUpload = JSON.parse(value) as FileUpload;
      if (imageMime(fileUpload)) {
        const pkCol = columns[pkIndex].name;
        const pkVal = context.row.original[pkIndex] as string;
        const url = imageUrl({
          tableName,
          pkCol,
          pkVal,
          fileColName: cell.col.name,
        });

        return <Image url={url} mime={fileUpload.mime_type} />;
      }
    } else if (cell.isFiles) {
      const fileUploads = JSON.parse(value) as FileUploads;

      const indexes: number[] = [];
      for (let i = 0; i < fileUploads.length; ++i) {
        const file = fileUploads[i];
        if (imageMime(file)) {
          indexes.push(i);
        }

        if (indexes.length >= 3) break;
      }

      if (indexes.length > 0) {
        const pkCol = columns[pkIndex].name;
        const pkVal = context.row.original[pkIndex] as string;
        return (
          <div class="flex gap-2">
            <For each={indexes}>
              {(index: number) => {
                const fileUpload = fileUploads[index];
                const url = imageUrl({
                  tableName,
                  pkCol,
                  pkVal,
                  fileColName: cell.col.name,
                  index,
                });

                return <Image url={url} mime={fileUpload.mime_type} />;
              }}
            </For>
          </div>
        );
      }
    }
  }

  return value;
}

function Image(props: { url: string; mime: string }) {
  const [imageData] = createResource(async () => {
    const response = await adminFetch(props.url);
    return await asyncBase64Encode(await response.blob());
  });

  return (
    <Switch>
      <Match when={imageData.error}>{imageData.error}</Match>

      <Match when={imageData.loading}>Loading</Match>

      <Match when={imageData()}>
        <img class="size-[50px]" src={imageData()} />
      </Match>
    </Switch>
  );
}

function imageUrl(opts: {
  tableName: string;
  pkCol: string;
  pkVal: string;
  fileColName: string;
  index?: number;
}): string {
  const uri = `/table/${opts.tableName}/files?pk_column=${opts.pkCol}&pk_value=${opts.pkVal}&file_column_name=${opts.fileColName}`;
  const index = opts.index;
  if (index) {
    return `${uri}&file_index=${index}`;
  }
  return uri;
}

function TableHeaderRightHandButtons(props: {
  table: Table | View;
  allTables: Table[];
  schemaRefetch: () => Promise<void>;
}) {
  const table = () => props.table;
  const hidden = () => hiddenTable(table());
  const type = () => tableType(table());

  const satisfiesRecordApi = createMemo(() => {
    const t = type();
    if (t === "table") {
      return tableSatisfiesRecordApiRequirements(
        props.table as Table,
        props.allTables,
      );
    } else if (t === "view") {
      return viewSatisfiesRecordApiRequirements(
        props.table as View,
        props.allTables,
      );
    }

    return false;
  });

  const config = createConfigQuery();
  const recordApi = (): RecordApiConfig | undefined => {
    for (const c of config.data?.config?.recordApis ?? []) {
      if (c.tableName === table().name) {
        return c;
      }
    }
  };

  return (
    <div class="flex items-center justify-end gap-2">
      {/* Delete table button */}
      {!hidden() && (
        <DestructiveActionButton
          action={() =>
            (async () => {
              await dropTable({
                name: table().name,
              });

              invalidateConfig();
              await props.schemaRefetch();
            })().catch(console.error)
          }
          msg="Deleting a table will irreversibly delete all the data contained. Are you sure you'd like to continue?"
        >
          <div class="flex items-center gap-2">
            Delete <TbTrash />
          </div>
        </DestructiveActionButton>
      )}

      {/* Record API settings*/}
      {(type() === "table" || type() === "view") && !hidden() && (
        <SafeSheet
          children={(sheet) => {
            return (
              <>
                <SheetContent class={sheetMaxWidth}>
                  <RecordApiSettingsForm schema={props.table} {...sheet} />
                </SheetContent>

                <SheetTrigger
                  as={(props: DialogTriggerProps) => (
                    <Tooltip>
                      <TooltipTrigger as="div">
                        <Button
                          variant="outline"
                          class="flex items-center"
                          disabled={!satisfiesRecordApi()}
                          {...props}
                        >
                          API
                          <Checkbox
                            disabled={!satisfiesRecordApi()}
                            checked={recordApi() !== undefined}
                          />
                        </Button>
                      </TooltipTrigger>

                      <TooltipContent>
                        {satisfiesRecordApi() ? (
                          <p>Create a Record API endpoint for this table.</p>
                        ) : (
                          <p>
                            This table does not satisfy the requirements for
                            exposing a Record API: strictly typed {"&"} UUIDv7
                            primary key column.
                          </p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  )}
                />
              </>
            );
          }}
        />
      )}

      {type() === "table" && !hidden() && (
        <SafeSheet
          children={(sheet) => {
            return (
              <>
                <SheetContent class={sheetMaxWidth}>
                  <CreateAlterTableForm
                    schemaRefetch={props.schemaRefetch}
                    allTables={props.allTables}
                    setSelected={() => {
                      /* No selection change needed for AlterTable */
                    }}
                    schema={props.table as Table}
                    {...sheet}
                  />
                </SheetContent>

                <SheetTrigger
                  as={(props: DialogTriggerProps) => (
                    <Button variant="default" {...props}>
                      <div class="flex items-center gap-2">
                        Alter <TbTable />
                      </div>
                    </Button>
                  )}
                />
              </>
            );
          }}
        />
      )}
    </div>
  );
}

function TableHeader(props: {
  table: Table | View;
  indexes: TableIndex[];
  triggers: TableTrigger[];
  allTables: Table[];
  schemaRefetch: () => Promise<void>;
  rowsRefetch: () => Promise<void>;
}) {
  const type = () => tableType(props.table);
  const hasSchema = () => type() === "table";
  const header = () => {
    switch (type()) {
      case "view":
        return "View";
      case "virtualTable":
        return "Virtual Table";
      default:
        return "Table";
    }
  };

  const LeftButtons = () => (
    <>
      <IconButton tooltip="Refresh Data" onClick={props.rowsRefetch}>
        <TbRefresh size={18} />
      </IconButton>

      {hasSchema() && <SchemaDialog tableName={props.table.name} />}

      {hasSchema() && import.meta.env.DEV && (
        <DebugSchemaDialogButton
          table={props.table as Table}
          indexes={props.indexes}
          triggers={props.triggers}
        />
      )}
    </>
  );

  return (
    <Header
      title={header()}
      titleSelect={props.table.name}
      left={<LeftButtons />}
      right={
        <TableHeaderRightHandButtons
          table={props.table}
          allTables={props.allTables}
          schemaRefetch={props.schemaRefetch}
        />
      }
    />
  );
}

type TableStore = {
  selected: Table | View;
  schemas: ListSchemasResponse;

  // Filter & pagination
  filter: string | null;
  pagination: PaginationState;
};

type TableState = {
  store: Store<TableStore>;
  setStore: SetStoreFunction<TableStore>;

  response: ListRowsResponse;

  // Derived
  pkColumnIndex: number;
  columnDefs: ColumnDef<RowData>[];
};

async function buildTableState(
  source: FetchArgs,
  store: Store<TableStore>,
  setStore: SetStoreFunction<TableStore>,
  info: ResourceFetcherInfo<TableState>,
): Promise<TableState> {
  const response = await fetchRows(source, { value: info.value?.response });

  const pkColumnIndex = findPrimaryKeyColumnIndex(response.columns);
  const columnDefs = buildColumnDefs(
    store.selected.name,
    tableType(store.selected),
    pkColumnIndex,
    response.columns,
  );

  return {
    store,
    setStore,
    response,
    pkColumnIndex,
    columnDefs,
  };
}

function buildColumnDefs(
  tableName: string,
  tableType: TableType,
  pkColumn: number,
  columns: Column[],
): ColumnDef<RowData>[] {
  return columns.map((col, idx) => {
    const fk = getForeignKey(col.options);
    const notNull = isNotNull(col.options);
    const isJSON = isJSONColumn(col);
    const isUUIDv7 = isUUIDv7Column(col);
    const isFile = isFileUploadColumn(col);
    const isFiles = isFileUploadsColumn(col);

    // TODO: Add support for custom json schemas or generally JSON types.
    const type = (() => {
      if (isUUIDv7) return "UUIDv7";
      if (isJSON) return "JSON";
      if (isFile) return "File";
      if (isFiles) return "File[]";
      return col.data_type;
    })();

    const typeName = notNull ? type : type + "?";
    const fkSuffix = fk ? ` ‣ ${fk.foreign_table}[${fk.referred_columns}]` : "";
    const header = `${col.name} [${typeName}] ${fkSuffix}`;

    return {
      header,
      cell: (context) =>
        renderCell(context, tableName, columns, pkColumn, {
          col: col,
          isUUIDv7,
          isJSON,
          // FIXME: Whether or not an image can be rendered depends on whether
          // Record API read-access is configured and not the tableType. We
          // could also consider to decouple by providing a dedicated admin
          // file-access endpoint.
          isFile: isFile && tableType !== "view",
          isFiles: isFiles && tableType !== "view",
        }),
      accessorFn: (row: RowData) => row[idx],
    };
  });
}

function RowDataTable(props: {
  state: TableState;
  rowsRefetch: () => Promise<void>;
}) {
  const [editRow, setEditRow] = createSignal<FormRow | undefined>();
  const [selectedRows, setSelectedRows] = createSignal(new Set<string>());

  const table = () => props.state.store.selected;
  const mutable = () => tableType(table()) === "table" && !hiddenTable(table());

  const rowsRefetch = () => props.rowsRefetch().catch(console.error);
  const columns = (): Column[] => props.state.response.columns;
  const totalRowCount = () => Number(props.state.response.total_row_count);
  const pkColumnIndex = () => props.state.pkColumnIndex;

  return (
    <>
      <SafeSheet
        open={[
          () => editRow() !== undefined,
          (isOpen: boolean | ((value: boolean) => boolean)) => {
            if (!isOpen) {
              setEditRow(undefined);
            }
          },
        ]}
        children={(sheet) => {
          return (
            <>
              <SheetContent class={sheetMaxWidth}>
                <InsertUpdateRowForm
                  schema={table() as Table}
                  rowsRefetch={rowsRefetch}
                  row={editRow()}
                  {...sheet}
                />
              </SheetContent>

              <FilterBar
                initial={props.state.store.filter ?? undefined}
                onSubmit={(value: string) => {
                  if (value === props.state.store.filter) {
                    rowsRefetch();
                  } else {
                    props.state.setStore("filter", (_prev) => value);
                  }
                }}
                example='e.g. "latency[lt]=2 AND status=200"'
              />

              <div class="space-y-2.5 overflow-auto">
                <DataTable
                  columns={() => props.state.columnDefs}
                  data={() => props.state.response.rows}
                  rowCount={totalRowCount()}
                  initialPagination={props.state.store.pagination}
                  onPaginationChange={(
                    p:
                      | PaginationState
                      | ((old: PaginationState) => PaginationState),
                  ) => {
                    props.state.setStore("pagination", p);
                  }}
                  onRowClick={
                    mutable()
                      ? (_idx: number, row: RowData) => {
                          setEditRow(rowDataToRow(columns(), row));
                        }
                      : undefined
                  }
                  onRowSelection={
                    mutable()
                      ? (_idx: number, row: RowData, value: boolean) => {
                          const rows = new Set(selectedRows());
                          const rowId = row[pkColumnIndex()] as string;
                          if (value) {
                            rows.add(rowId);
                          } else {
                            rows.delete(rowId);
                          }
                          setSelectedRows(rows);
                        }
                      : undefined
                  }
                />
              </div>
            </>
          );
        }}
      />

      {mutable() && (
        <div class="my-2 flex gap-2">
          {/* Insert Rows */}
          <SafeSheet
            children={(sheet) => {
              return (
                <>
                  <SheetContent class={sheetMaxWidth}>
                    <InsertUpdateRowForm
                      schema={table() as Table}
                      rowsRefetch={rowsRefetch}
                      {...sheet}
                    />
                  </SheetContent>

                  <SheetTrigger
                    as={(props: DialogTriggerProps) => (
                      <Button variant="default" {...props}>
                        Insert Row
                      </Button>
                    )}
                  />
                </>
              );
            }}
          />

          {/* Delete rows */}
          <Button
            variant="destructive"
            disabled={selectedRows().size === 0}
            onClick={() => {
              const ids = Array.from(selectedRows());
              if (ids.length === 0) {
                return;
              }

              deleteRows(table().name, {
                primary_key_column: columns()[pkColumnIndex()].name,
                values: ids,
              })
                // eslint-disable-next-line solid/reactivity
                .then(() => {
                  setSelectedRows(new Set<string>());
                  rowsRefetch();
                })
                .catch(console.error);
            }}
          >
            Delete rows
          </Button>
        </div>
      )}
    </>
  );
}

export function TablePane(props: {
  selectedTable: Table | View;
  schemas: ListSchemasResponse;
  schemaRefetch: () => Promise<void>;
}) {
  const [editIndex, setEditIndex] = createSignal<TableIndex | undefined>();
  const [selectedIndexes, setSelectedIndexes] = createSignal(new Set<string>());

  const table = () => props.selectedTable;
  const indexes = () =>
    props.schemas.indexes.filter((idx) => idx.table_name === table().name);
  const triggers = () =>
    props.schemas.triggers.filter((trig) => trig.table_name === table().name);

  // Derived table() props.
  const type = () => tableType(table());
  const hidden = () => hiddenTable(table());

  const [searchParams, setSearchParams] = useSearchParams<{
    filter?: string;
    pageSize?: string;
  }>();

  function newStore({ filter }: { filter: string | null }): TableStore {
    return {
      selected: props.selectedTable,
      schemas: props.schemas,
      filter,
      pagination: defaultPaginationState({
        // NOTE: We index has to start at 0 since we're building the list of
        // stable cursors as we incrementally page.
        index: 0,
        size: safeParseInt(searchParams.pageSize) ?? 20,
      }),
    };
  }

  // Cursors are deliberately kept out of the store to avoid tracking.
  let cursors: string[] = [];
  const [store, setStore] = createStore<TableStore>(
    newStore({ filter: searchParams.filter ?? null }),
  );
  createEffect(() => {
    // When switching tables/views, recreate the state. This includes the main
    // store but also the current search params and the untracked cursors.
    if (store.selected.name !== props.selectedTable.name) {
      cursors = [];

      // The new table probably has different schema, thus filters must not
      // carry over.
      const newFilter = { filter: null };
      setSearchParams(newFilter);

      setStore(newStore(newFilter));
      return;
    }

    // When the filter changes, we also update the search params to be in sync.
    setSearchParams({
      filter: store.filter,
    });
  });

  const buildFetchArgs = (): FetchArgs => ({
    // We need to access store properties here to react to them changing. It's
    // fine grained, so accessing a nested object like store.pagination isn't
    // enough.
    tableName: store.selected.name,
    filter: store.filter,
    pageSize: store.pagination.pageSize,
    pageIndex: store.pagination.pageIndex,
    cursors: cursors,
  });
  const [state, { refetch: rowsRefetch }] = createResource(
    buildFetchArgs,
    async (source: FetchArgs, info: ResourceFetcherInfo<TableState>) => {
      try {
        return await buildTableState(source, store, setStore, info);
      } catch (err) {
        setSearchParams({
          filter: undefined,
          pageIndex: undefined,
          pageSize: undefined,
        });

        throw err;
      }
    },
  );

  return (
    <>
      <TableHeader
        table={table()}
        indexes={indexes()}
        triggers={triggers()}
        allTables={props.schemas.tables}
        schemaRefetch={props.schemaRefetch}
        rowsRefetch={() =>
          (async () => {
            await rowsRefetch();
          })()
        }
      />

      <div class="flex flex-col gap-8 p-4">
        <Switch fallback={<>Loading...</>}>
          <Match when={state.error}>
            <div class="my-2 flex flex-col gap-4">
              Failed to fetch rows: {`${state.error}`}
              <div>
                <Button onClick={() => window.location.reload()}>Reload</Button>
              </div>
            </div>
          </Match>

          <Match when={state()}>
            <RowDataTable
              state={state()!}
              rowsRefetch={() =>
                (async () => {
                  await rowsRefetch();
                })()
              }
            />
          </Match>
        </Switch>

        {type() === "table" && (
          <div id="indexes">
            <h2>Indexes</h2>

            <SafeSheet
              open={[
                () => editIndex() !== undefined,
                (isOpen: boolean | ((value: boolean) => boolean)) => {
                  if (!isOpen) {
                    setEditIndex(undefined);
                  }
                },
              ]}
              children={(sheet) => {
                return (
                  <>
                    <SheetContent class={sheetMaxWidth}>
                      <CreateAlterIndexForm
                        schema={editIndex()}
                        table={table() as Table}
                        schemaRefetch={props.schemaRefetch}
                        {...sheet}
                      />
                    </SheetContent>

                    <div class="space-y-2.5 overflow-auto">
                      <DataTable
                        columns={() => indexColumns}
                        data={indexes}
                        onRowClick={
                          hidden()
                            ? undefined
                            : (_idx: number, index: TableIndex) => {
                                setEditIndex(index);
                              }
                        }
                        onRowSelection={
                          hidden()
                            ? undefined
                            : (
                                _idx: number,
                                index: TableIndex,
                                value: boolean,
                              ) => {
                                const rows = new Set(selectedIndexes());
                                if (value) {
                                  rows.add(index.name);
                                } else {
                                  rows.delete(index.name);
                                }
                                setSelectedIndexes(rows);
                              }
                        }
                      />
                    </div>
                  </>
                );
              }}
            />

            {!hidden() && (
              <div class="mt-2 flex gap-2">
                <SafeSheet
                  children={(sheet) => {
                    return (
                      <>
                        <SheetContent class={sheetMaxWidth}>
                          <CreateAlterIndexForm
                            schemaRefetch={props.schemaRefetch}
                            table={table() as Table}
                            {...sheet}
                          />
                        </SheetContent>

                        <SheetTrigger
                          as={(props: DialogTriggerProps) => (
                            <Button variant="default" {...props}>
                              Add Index
                            </Button>
                          )}
                        />
                      </>
                    );
                  }}
                />

                <Button
                  variant="destructive"
                  disabled={selectedIndexes().size == 0}
                  onClick={() => {
                    const names = Array.from(selectedIndexes());
                    if (names.length == 0) {
                      return;
                    }

                    const deleteIndexes = async () => {
                      for (const name of names) {
                        await dropIndex({ name });
                      }

                      setSelectedIndexes(new Set<string>());
                      props.schemaRefetch();
                    };

                    deleteIndexes().catch(console.error);
                  }}
                >
                  Delete indexes
                </Button>
              </div>
            )}
          </div>
        )}

        {type() === "table" && (
          <div id="triggers">
            <h2>Triggers</h2>

            <p class="text-sm">
              The admin dashboard currently does not support modifying triggers.
              Please use the editor to{" "}
              <a href="https://www.sqlite.org/lang_createtrigger.html">
                create
              </a>{" "}
              new triggers or{" "}
              <a href="https://sqlite.org/lang_droptrigger.html">drop</a>{" "}
              existing ones.
            </p>

            <div class="mt-4">
              <DataTable columns={() => triggerColumns} data={triggers} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const sheetMaxWidth = "sm:max-w-[520px]";

const indexColumns = [
  {
    header: "name",
    accessorKey: "name",
  },
  {
    header: "columns",
    accessorFn: (index: TableIndex) => {
      return index.columns.map((c) => c.column_name).join(", ");
    },
  },
  {
    header: "unique",
    accessorKey: "unique",
  },
  {
    header: "predicate",
    accessorFn: (index: TableIndex) => {
      return index.predicate?.replaceAll("<>", "!=");
    },
  },
] as ColumnDef<TableIndex>[];

const triggerColumnHelper = createColumnHelper<TableTrigger>();
const triggerColumns = [
  triggerColumnHelper.accessor("name", {}),
  triggerColumnHelper.accessor("sql", {
    header: "statement",
    cell: (props) => <pre class="text-xs">{props.getValue()}</pre>,
  }),
] as ColumnDef<TableTrigger>[];
