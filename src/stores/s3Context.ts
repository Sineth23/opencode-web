import { createSignal } from "solid-js";

export interface S3FileContent {
  key: string;
  size: number;
  content: string;
  timestamp: number;
}

const [selectedFiles, setSelectedFiles] = createSignal<S3FileContent[]>([]);

export function addSelectedFile(file: S3FileContent) {
  setSelectedFiles((files) => {
    // Don't add duplicate
    if (files.some((f) => f.key === file.key)) {
      return files;
    }
    return [...files, file];
  });
}

export function removeSelectedFile(fileKey: string) {
  setSelectedFiles((files) => files.filter((f) => f.key !== fileKey));
}

export function clearSelectedFiles() {
  setSelectedFiles([]);
}

export function getSelectedFiles() {
  return selectedFiles();
}

export function getSelectedFilesContent(): string {
  const files = selectedFiles();
  if (files.length === 0) return "";

  return files
    .map((file) => {
      return `\n<s3_file key="${file.key}" size="${file.size}">\n${file.content}\n</s3_file>\n`;
    })
    .join("\n");
}
