import { useRef, useState } from 'react';

import styles from './UploadZone.module.css';

// Decimal units (1000-based) — matches what macOS Finder, iOS, and most
// file browsers report, so our "X MB" agrees with what the user sees on
// disk. (Binary MiB would inflate the number by ~5%.)
function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000 * 1000 * 1000) return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
  return `${(bytes / (1000 * 1000 * 1000)).toFixed(2)} GB`;
}

export default function UploadZone({
  label,
  sublabel,
  icon,
  accept,
  file,
  onFileSelected,
  onRemove,
  maxSizeMB,
  compact = false,
  zoneStyle,
}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [sizeError, setSizeError] = useState('');

  const openPicker = () => inputRef.current && inputRef.current.click();

  const tryAccept = (selected) => {
    if (!selected) return;
    if (maxSizeMB && selected.size > maxSizeMB * 1000 * 1000) {
      setSizeError(
        `File too large (${formatSize(selected.size)}) — max ${maxSizeMB} MB.`
      );
      return;
    }
    setSizeError('');
    onFileSelected(selected);
  };

  const handleInputChange = (e) => {
    const selected = e.target.files && e.target.files[0];
    tryAccept(selected);
    e.target.value = '';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const dropped = e.dataTransfer.files && e.dataTransfer.files[0];
    tryAccept(dropped);
  };

  const hasFile = Boolean(file);
  const zoneClass = [
    styles.zone,
    hasFile ? styles.zoneFilled : '',
    dragOver ? styles.zoneDragOver : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Compact mode: roughly half the height, smaller icon/label, less
  // padding. Used on the face-swap creator so the whole form fits
  // above the fold.
  const compactZoneStyle = compact
    ? { minHeight: 96, padding: '12px 14px', gap: 4 }
    : undefined;
  const compactIconStyle = compact ? { fontSize: 20 } : undefined;
  const compactLabelStyle = compact ? { fontSize: 14 } : undefined;
  const compactSubStyle = compact ? { fontSize: 9, letterSpacing: '0.08em' } : undefined;

  return (
    <div
      className={zoneClass}
      style={{ ...compactZoneStyle, ...zoneStyle }}
      onClick={hasFile ? undefined : openPicker}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !hasFile) {
          e.preventDefault();
          openPicker();
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className={styles.input}
        onChange={handleInputChange}
      />

      {hasFile && (
        <button
          type="button"
          className={styles.remove}
          aria-label="Remove file"
          onClick={(e) => {
            e.stopPropagation();
            setSizeError('');
            onRemove();
          }}
        >
          ×
        </button>
      )}

      <div className={styles.icon} style={compactIconStyle} aria-hidden="true">
        {hasFile ? '✓' : icon}
      </div>
      <div className={styles.label} style={compactLabelStyle}>{label}</div>
      {hasFile ? (
        <div className={styles.fileMeta}>
          <span className={styles.fileName}>{file.name}</span>
          <span className={styles.fileSize}>{formatSize(file.size)}</span>
        </div>
      ) : (
        <div className={styles.sublabel} style={compactSubStyle}>{sublabel}</div>
      )}
      {sizeError && (
        <div
          style={{
            marginTop: 8,
            color: '#ff8a8a',
            fontSize: 12,
            textAlign: 'center',
            padding: '0 12px',
          }}
        >
          {sizeError}
        </div>
      )}
    </div>
  );
}
