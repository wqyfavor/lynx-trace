// Copyright (C) 2025 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {downloadData} from '../../base/download_utils';
import {ThreadSliceDetailsPanel} from '../../components/details/thread_slice_details_tab';
import {renderDetails} from '../../components/details/slice_details';
import {Args, ArgsDict, getArgs} from '../../components/sql_utils/args';
import {asArgSetId, asSliceSqlId} from '../../components/sql_utils/core_types';
import {getSlice, SliceDetails} from '../../components/sql_utils/slice';
import {LYNX_MEMORY_PLUGIN_ID} from '../../lynx_perf/constants';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {TrackEventSelection} from '../../public/selection';
import {Trace} from '../../public/trace';
import {NUM, NUM_NULL} from '../../trace_processor/query_result';
import {DetailsShell} from '../../widgets/details_shell';
import {GridLayout, GridLayoutColumn} from '../../widgets/grid_layout';
import {Tree, TreeNode} from '../../widgets/tree';

const CAPTURE_SNAPSHOT = 'capture_snapshot';
const SNAPSHOT_CHUNK = 'snapshot_chunk';

interface SnapshotFileWritableStream {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface SnapshotFileHandle {
  createWritable(): Promise<SnapshotFileWritableStream>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

interface WindowWithSaveFilePicker {
  showSaveFilePicker?: (
    options?: SaveFilePickerOptions,
  ) => Promise<SnapshotFileHandle>;
}

interface SnapshotDesc {
  vmType: string;
  baseUsage: number;
  pageRssUsage: number;
  accUsage: number;
}

interface SnapshotDetails {
  sliceId: number;
  ts: number;
  vmId: string;
  snapshotId: string;
  totalLength: number;
  chunkSize: number;
  chunkCount: number;
  desc: SnapshotDesc;
}

interface SnapshotChunk {
  chunkIndex: number;
  offset: number;
  content: string;
}

interface SectionWithRightContentAttrs {
  title: string;
  rightContent?: m.Children;
}

class SectionWithRightContent implements
  m.ClassComponent<SectionWithRightContentAttrs> {
  view({attrs, children}: m.CVnode<SectionWithRightContentAttrs>) {
    return m(
      'section.pf-section',
      m('header', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        },
      }, [
        m('h1', attrs.title),
        attrs.rightContent,
      ]),
      m('article', children),
    );
  }
}

export class MemoryVitalsDetailsPanel implements TrackEventDetailsPanel {
  private readonly ctx: Trace;
  private readonly defaultPanel: ThreadSliceDetailsPanel;
  private sliceDetail?: SliceDetails;
  private currentSnapshot?: SnapshotDetails;
  private previousSnapshot?: SnapshotDetails;
  private snapshots: SnapshotDetails[] = [];
  private snapshotIndex = 0;
  private snapshotTotal = 0;
  private useDefaultPanel = false;
  private downloading = false;

  constructor(ctx: Trace) {
    this.ctx = ctx;
    this.defaultPanel = new ThreadSliceDetailsPanel(ctx);
  }

  async load(selection: TrackEventSelection) {
    this.useDefaultPanel = false;
    this.sliceDetail = await getSlice(
      this.ctx.engine,
      asSliceSqlId(selection.eventId),
    );

    if (this.sliceDetail?.name !== CAPTURE_SNAPSHOT) {
      this.useDefaultPanel = true;
      await this.defaultPanel.load(selection);
      return;
    }

    this.currentSnapshot = this.parseSnapshotDetails(this.sliceDetail);
    if (this.currentSnapshot === undefined) {
      return;
    }

    const snapshots = await this.loadSnapshotsForVm(
      this.currentSnapshot.vmId,
    );
    this.snapshots = snapshots;
    this.snapshotTotal = this.snapshots.length;
    const snapshotIndex = this.snapshots.findIndex(
      (snapshot) => snapshot.sliceId === this.currentSnapshot?.sliceId,
    );
    this.setCurrentSnapshot(snapshotIndex < 0 ? 0 : snapshotIndex);
  }

  render(): m.Children {
    if (this.useDefaultPanel) {
      return this.defaultPanel.render();
    }

    if (this.sliceDetail === undefined) {
      return m(DetailsShell, {title: 'Memory Snapshot', description: 'Loading...'});
    }

    if (this.currentSnapshot === undefined) {
      return m(
        DetailsShell,
        {title: 'Memory Snapshot', description: this.sliceDetail.name},
        m('p', 'No capture snapshot details found.'),
      );
    }

    return m(
      DetailsShell,
      {title: 'Memory Snapshot', description: this.sliceDetail.name},
      m(
        GridLayout,
        renderDetails(this.ctx, this.sliceDetail),
        m(
          GridLayoutColumn,
          this.renderSnapshotSection(this.currentSnapshot),
        ),
      ),
    );
  }

  private renderSnapshotSection(snapshot: SnapshotDetails): m.Children {
    const rssUsage = snapshot.desc.baseUsage + snapshot.desc.pageRssUsage;
    const accDelta =
      this.previousSnapshot === undefined ?
        undefined :
        snapshot.desc.accUsage - this.previousSnapshot.desc.accUsage;
    const rssDelta =
      this.previousSnapshot === undefined ?
        undefined :
        rssUsage -
          (
            this.previousSnapshot.desc.baseUsage +
            this.previousSnapshot.desc.pageRssUsage
          );

    return m(
      SectionWithRightContent,
      {
        title: 'Capture Snapshot',
        rightContent: this.renderSnapshotNavigationButtons(),
      },
      [
        m(Tree, [
          m(TreeNode, {left: 'ID', right: snapshot.vmId}),
          m(TreeNode, {
            left: 'Snapshot',
            right: `${this.snapshotIndex + 1}/${this.snapshotTotal}`,
          }),
          m(TreeNode, {left: 'VM Type', right: snapshot.desc.vmType}),
          m(TreeNode, {
            left: 'Accumulate',
            right: this.renderMemoryUsage(snapshot.desc.accUsage, accDelta),
          }),
          m(TreeNode, {
            left: 'RSS',
            right: this.renderMemoryUsage(rssUsage, rssDelta),
          }),
        ]),
        m('button', {
          disabled: this.downloading,
          onclick: async () => {
            await this.downloadCurrentSnapshot();
          },
          style: {
            ...this.getSnapshotButtonStyle(!this.downloading),
            marginTop: '12px',
            padding: '4px 10px',
          },
        }, this.downloading ? 'Downloading...' : 'Download'),
        this.renderSnapshotMemoryCharts(),
      ],
    );
  }

  private renderSnapshotMemoryCharts(): m.Children {
    if (this.snapshots.length === 0) {
      return null;
    }

    return m('div', {
      style: {
        marginTop: '16px',
      },
    }, [
      this.renderSnapshotMemoryChart(
        'Accumulate',
        this.snapshots.map((snapshot) => snapshot.desc.accUsage),
      ),
      this.renderSnapshotMemoryChart(
        'RSS',
        this.snapshots.map((snapshot) => this.getSnapshotRssUsage(snapshot)),
      ),
    ]);
  }

  private renderSnapshotMemoryChart(
    title: string,
    values: number[],
  ): m.Children {
    const width = 360;
    const height = 180;
    const left = 48;
    const right = 12;
    const top = 38;
    const bottom = 32;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const maxValue = Math.max(1, ...values);
    const barSlotWidth = plotWidth / values.length;
    const barWidth = Math.max(4, Math.min(24, barSlotWidth * 0.6));
    const labelStep = Math.max(1, Math.ceil(values.length / 8));

    return m('div', {
      style: {
        marginTop: '12px',
      },
    }, [
      m('div', {
        style: {
          marginBottom: '4px',
          fontSize: '12px',
          fontWeight: 'bold',
        },
      }, title),
      m('svg', {
        viewBox: `0 0 ${width} ${height}`,
        style: {
          width: '100%',
          height: '180px',
          border: '1px solid rgba(0, 0, 0, 0.08)',
          borderRadius: '3px',
          background: '#fff',
        },
      }, [
        m('line', {
          x1: left,
          y1: top,
          x2: left,
          y2: top + plotHeight,
          stroke: 'rgba(0, 0, 0, 0.35)',
        }),
        m('line', {
          x1: left,
          y1: top + plotHeight,
          x2: width - right,
          y2: top + plotHeight,
          stroke: 'rgba(0, 0, 0, 0.35)',
        }),
        m('text', {
          'x': left - 6,
          'y': top + 4,
          'text-anchor': 'end',
          'style': {
            fontSize: '10px',
            fill: 'rgba(0, 0, 0, 0.65)',
          },
        }, this.formatBytes(maxValue)),
        m('text', {
          'x': left - 6,
          'y': top + plotHeight,
          'text-anchor': 'end',
          'style': {
            fontSize: '10px',
            fill: 'rgba(0, 0, 0, 0.65)',
          },
        }, '0'),
        values.map((value, index) => {
          const barHeight = (value / maxValue) * plotHeight;
          const x = left + index * barSlotWidth +
            (barSlotWidth - barWidth) / 2;
          const y = top + plotHeight - barHeight;
          const selected = index === this.snapshotIndex;
          const deltaLabel = index === 0 ?
            '-' :
            this.formatDeltaBytes(value - values[index - 1]);
          const shouldRenderLabel =
            index === 0 ||
            index === values.length - 1 ||
            selected ||
            index % labelStep === 0;

          return [
            m('rect', {
              x,
              y,
              width: barWidth,
              height: barHeight,
              fill: selected ? '#8e44ad' : '#6fa8dc',
            }, [
              m('title', `#${index + 1}: ${this.formatBytes(value)}`),
            ]),
            shouldRenderLabel ? m('text', {
              'x': x + barWidth / 2,
              'y': top + plotHeight + 14,
              'text-anchor': 'middle',
              'style': {
                fontSize: '10px',
                fill: selected ? '#8e44ad' : 'rgba(0, 0, 0, 0.65)',
                fontWeight: selected ? 'bold' : 'normal',
              },
            }, String(index + 1)) : null,
            m('text', {
              'x': x + barWidth / 2,
              'y': Math.max(10, y - 6),
              'text-anchor': 'middle',
              'style': {
                fontSize: '9px',
                fill: selected ? '#8e44ad' : 'rgba(0, 0, 0, 0.65)',
                fontWeight: selected ? 'bold' : 'normal',
              },
            }, deltaLabel),
          ];
        }),
      ]),
    ]);
  }

  private getSnapshotRssUsage(snapshot: SnapshotDetails): number {
    return snapshot.desc.baseUsage + snapshot.desc.pageRssUsage;
  }

  private renderSnapshotNavigationButtons(): m.Children {
    return m('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
      },
    }, [
      this.renderSnapshotNavigationButton('left', this.snapshotIndex > 0),
      this.renderSnapshotNavigationButton(
        'right',
        this.snapshotIndex < this.snapshotTotal - 1,
      ),
    ]);
  }

  private renderSnapshotNavigationButton(
    direction: 'left' | 'right',
    enabled: boolean,
  ): m.Children {
    return m('button', {
      disabled: !enabled,
      onclick: (e: Event) => {
        e.stopPropagation();
        if (!enabled) {
          return;
        }

        this.selectSnapshot(
          direction === 'left' ? this.snapshotIndex - 1 : this.snapshotIndex + 1,
        );
      },
      style: {
        ...this.getSnapshotButtonStyle(enabled),
        width: '24px',
        height: '22px',
      },
      title: direction === 'left' ? 'Previous snapshot' : 'Next snapshot',
    }, m('span', {
      style: {
        width: '0',
        height: '0',
        borderTop: '5px solid transparent',
        borderBottom: '5px solid transparent',
        ...(direction === 'left' ?
          {borderRight: '8px solid #333'} :
          {borderLeft: '8px solid #333'}),
      },
    }));
  }

  private getSnapshotButtonStyle(enabled: boolean) {
    return {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: '1px solid rgba(0, 0, 0, 0.25)',
      borderRadius: '3px',
      background: enabled ? '#fff' : 'rgba(0, 0, 0, 0.04)',
      cursor: enabled ? 'pointer' : 'not-allowed',
      opacity: enabled ? '1' : '0.45',
    };
  }

  private selectSnapshot(index: number) {
    if (index < 0 || index >= this.snapshots.length) {
      return;
    }

    this.setCurrentSnapshot(index);
    if (this.currentSnapshot !== undefined) {
      this.ctx.selection.selectTrackEvent(
        LYNX_MEMORY_PLUGIN_ID,
        this.currentSnapshot.sliceId,
      );
    }
    m.redraw();
  }

  private setCurrentSnapshot(index: number) {
    this.snapshotIndex = index;
    this.currentSnapshot = this.snapshots[index];
    this.previousSnapshot =
      index > 0 ? this.snapshots[index - 1] : undefined;
  }

  private async downloadCurrentSnapshot() {
    if (this.currentSnapshot === undefined || this.downloading) {
      return;
    }

    this.downloading = true;
    m.redraw();
    try {
      const content = await this.loadSnapshotContent(this.currentSnapshot);
      const fileName =
        `${this.currentSnapshot.vmId}#${this.snapshotIndex + 1}.heapsnapshot`;
      await this.saveSnapshotFile(fileName, content);
    } catch (e) {
      if (this.isSaveFileCancelled(e)) {
        return;
      }

      // eslint-disable-next-line no-alert
      window.alert(`Failed to download snapshot: ${e}`);
    } finally {
      this.downloading = false;
      m.redraw();
    }
  }

  private async loadSnapshotContent(snapshot: SnapshotDetails): Promise<string> {
    const chunks = await this.loadSnapshotChunks(snapshot);
    return chunks.map((chunk) => chunk.content).join('');
  }

  private async loadSnapshotChunks(
    snapshot: SnapshotDetails,
  ): Promise<SnapshotChunk[]> {
    const result = await this.ctx.engine.query(`
      SELECT
        id,
        arg_set_id as argSetId
      FROM slice
      WHERE name = '${SNAPSHOT_CHUNK}'
        AND arg_set_id IS NOT NULL
      ORDER BY ts ASC
    `);

    const chunks: SnapshotChunk[] = [];
    for (
      const it = result.iter({id: NUM, argSetId: NUM_NULL});
      it.valid();
      it.next()
    ) {
      if (it.argSetId === null) {
        continue;
      }

      const args = await getArgs(this.ctx.engine, asArgSetId(it.argSetId));
      if (
        this.getSnapshotVmId(args) !== snapshot.vmId ||
        this.getArgDisplayValue(args, 'snapshot_id') !== snapshot.snapshotId
      ) {
        continue;
      }

      chunks.push({
        chunkIndex: this.getArgNumber(args, 'chunk_index'),
        offset: this.getArgNumber(args, 'offset'),
        content: this.getArgRawString(args, 'content') ?? '',
      });
    }

    return chunks.sort((a, b) =>
      a.chunkIndex === b.chunkIndex ?
        a.offset - b.offset :
        a.chunkIndex - b.chunkIndex,
    );
  }

  private async saveSnapshotFile(
    fileName: string,
    content: string,
  ): Promise<void> {
    const windowWithSaveFilePicker = window as unknown as
      WindowWithSaveFilePicker;
    if (windowWithSaveFilePicker.showSaveFilePicker !== undefined) {
      const fileHandle = await windowWithSaveFilePicker.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: 'Heap Snapshot',
            accept: {'application/json': ['.heapsnapshot']},
          },
        ],
      });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    }

    downloadData(fileName, new TextEncoder().encode(content).buffer);
  }

  private isSaveFileCancelled(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
  }

  private renderMemoryUsage(
    bytes: number,
    deltaBytes?: number,
  ): m.Child {
    return m('span', [
      this.formatBytes(bytes),
      deltaBytes === undefined ? null : [
        ' ',
        m('span', {
          style: {
            fontSize: '12px',
            opacity: '0.7',
          },
        }, `(${this.formatDeltaBytes(deltaBytes)} vs previous snapshot)`),
      ],
    ]);
  }

  private async loadSnapshotsForVm(
    vmId: string,
  ): Promise<SnapshotDetails[]> {
    const result = await this.ctx.engine.query(`
      SELECT
        id,
        arg_set_id as argSetId
      FROM slice
      WHERE name = '${CAPTURE_SNAPSHOT}'
        AND arg_set_id IS NOT NULL
      ORDER BY ts ASC
    `);

    const snapshots: SnapshotDetails[] = [];
    for (
      const it = result.iter({id: NUM, argSetId: NUM_NULL});
      it.valid();
      it.next()
    ) {
      if (it.argSetId === null) {
        continue;
      }

      const args = await getArgs(this.ctx.engine, asArgSetId(it.argSetId));
      if (this.getSnapshotVmId(args) !== vmId) {
        continue;
      }

      const slice = await getSlice(this.ctx.engine, asSliceSqlId(it.id));
      const snapshot = slice === undefined ?
        undefined :
        this.parseSnapshotDetails(slice);
      if (snapshot !== undefined) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  private parseSnapshotDetails(
    slice: SliceDetails,
  ): SnapshotDetails | undefined {
    const args = slice.args ?? {};
    const vmId = this.getSnapshotVmId(args);
    if (vmId === undefined) {
      return undefined;
    }

    return {
      sliceId: Number(slice.id),
      ts: Number(slice.ts),
      vmId,
      snapshotId: this.getArgDisplayValue(args, 'snapshot_id') ?? '',
      totalLength: this.getArgNumber(args, 'total_length'),
      chunkSize: this.getArgNumber(args, 'chunk_size'),
      chunkCount: this.getArgNumber(args, 'chunk_count'),
      desc: this.parseSnapshotDesc(this.getArgDisplayValue(args, 'desc')),
    };
  }

  private parseSnapshotDesc(desc?: string): SnapshotDesc {
    if (desc === undefined || !desc.trimStart().startsWith('{')) {
      return {
        vmType: '',
        baseUsage: 0,
        pageRssUsage: 0,
        accUsage: 0,
      };
    }

    try {
      const descRecord = JSON.parse(desc) as Record<string, unknown>;
      return {
        vmType: String(descRecord.vm_type ?? ''),
        baseUsage: Number(descRecord.base_usage) || 0,
        pageRssUsage: Number(descRecord.page_rss_usage) || 0,
        accUsage: Number(descRecord.acc_usage) || 0,
      };
    } catch {
      return {
        vmType: '',
        baseUsage: 0,
        pageRssUsage: 0,
        accUsage: 0,
      };
    }
  }

  private getArgDisplayValue(args: ArgsDict, key: string): string | undefined {
    const value = this.getArgValue(args, key);
    if (value === undefined) {
      return undefined;
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    return JSON.stringify(value);
  }

  private getArgRawString(args: ArgsDict, key: string): string | undefined {
    const value = this.getArgValue(args, key);
    if (value === undefined) {
      return undefined;
    }
    return typeof value === 'string' ?
      value :
      this.getArgDisplayValue(args, key);
  }

  private getArgNumber(args: ArgsDict, key: string): number {
    return Number(this.getArgDisplayValue(args, key)) || 0;
  }

  private getSnapshotVmId(args: ArgsDict): string | undefined {
    return this.getArgDisplayValue(args, 'id');
  }

  private getArgValue(args: ArgsDict, key: string): Args | undefined {
    return this.getValueByPath(args, key) ??
      this.getValueByPath(args, `debug.${key}`);
  }

  private getValueByPath(args: ArgsDict, path: string): Args | undefined {
    let value: Args | undefined = args;
    for (const key of path.split('.')) {
      if (value === null || typeof value !== 'object' || value instanceof Array) {
        return undefined;
      }
      value = value[key];
    }
    return value;
  }

  private formatBytes(bytes: number, decimals: number = 2): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  private formatDeltaBytes(bytes: number): string {
    const sign = bytes > 0 ? '+' : bytes < 0 ? '-' : '';
    return `${sign}${this.formatBytes(Math.abs(bytes))}`;
  }
}
