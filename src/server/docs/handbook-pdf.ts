import PDFDocument from 'pdfkit'

import { stripMarkdownLite } from '@/server/docs/strip-markdown-lite'

export type HandbookPdfSection = {
  category: string
  title: string
  summary: string | null
  bodyMd: string
  sourcePaths: string[] | null
}

/**
 * Renders handbook sections to a PDF buffer (Letter, Helvetica).
 */
export function buildHandbookPdfBuffer(input: {
  workspaceName: string
  repoLabel: string
  scopeLine: string
  generatedAt: string
  sections: HandbookPdfSection[]
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: 'LETTER', bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', (c) => chunks.push(c as Buffer))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.fontSize(20).fillColor('#111').text('Engineering handbook', { align: 'center' })
    doc.moveDown(0.5)
    doc.fontSize(11).fillColor('#444').text(input.workspaceName, { align: 'center' })
    doc.moveDown(0.25)
    doc.fontSize(10).text(input.repoLabel, { align: 'center' })
    doc.fontSize(9).text(input.scopeLine, { align: 'center' })
    doc.moveDown(0.25)
    doc.fontSize(8).fillColor('#666').text(`Generated ${input.generatedAt}`, { align: 'center' })
    doc.addPage()

    const textWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right

    for (let i = 0; i < input.sections.length; i++) {
      const s = input.sections[i]!
      if (i > 0) doc.addPage()
      doc.fontSize(9).fillColor('#666').text(s.category.toUpperCase().replace(/_/g, ' '), { continued: false })
      doc.moveDown(0.25)
      doc.fontSize(15).fillColor('#111').text(s.title, { width: textWidth })
      doc.moveDown(0.5)
      if (s.summary?.trim()) {
        doc.fontSize(10).fillColor('#333').text(s.summary.trim(), { width: textWidth, lineGap: 2 })
        doc.moveDown(0.75)
      }
      doc.fontSize(9).fillColor('#222').text(stripMarkdownLite(s.bodyMd), {
        width: textWidth,
        lineGap: 3,
        align: 'left',
      })
      doc.moveDown(1)
      if (s.sourcePaths?.length) {
        doc.fontSize(8).fillColor('#555').text('Evidence paths:', { underline: true })
        doc.moveDown(0.25)
        for (const p of s.sourcePaths) {
          doc.fontSize(7.5).fillColor('#444').text(`• ${p}`, { width: textWidth })
        }
      }
    }

    doc.end()
  })
}
