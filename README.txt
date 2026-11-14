MARGIN READER
PDF and EPUB reader with highlights, notes and read-aloud (neural voice, works offline)

THE APP (recommended)
  Double-click "Install Margin (app).cmd" once. It builds Margin.exe, installs it to
  your Programs folder and adds Desktop + Start menu shortcuts. Run it again after
  any update. Bring your books over with Library > Back up library (browser version)
  then Library > Restore from a backup (app).
  Book folders (app): Library > Add a folder (e.g. D:\8 BOOKS). New PDFs and EPUBs there
  join the library by themselves; they are read from the folder, never copied.
  "Make share zip.cmd" makes Margin.zip to give to friends (none of your books inside).

BROWSER VERSION
  Windows:  double-click "Start Margin.bat". A small black window opens (keep it open)
            and the reader opens in your browser at http://localhost:8765/
  Mac/Linux: python3 serve.py

FIRST TIME WITH THE NEURAL VOICE
  Press Listen. The voice downloads once (about 90 MB) - this needs internet.
  After that it is stored in the browser and works with no internet.
  If the neural voice can't load, Margin switches to your system voice.

USING IT
  Open a PDF or EPUB (Open button, or drag the file onto the window).
  EPUB books show as flowing text: + / - change the text size, Fit resets it.
  Highlight: select text, pick a colour. "Note" highlights and opens a note box.
  Click a highlight on the page to open its note.
  Listen: reads from the current page. Or select text > "Read from here".
  Space = play/pause.  S = show/hide sidebar.  + / - = zoom.
  Notes tab > Export saves all highlights and notes as a Markdown file.
  Save word: select or double-click a word > "Save word". It keeps the sentence
  you found it in and looks up a meaning (when online). Add your own meaning too.
  Words tab > Review: flashcards. Space shows the meaning, then 1-4 to grade.
  Words you know well come back less often. Export makes a CSV (Excel / Anki).

IF THE VOICE PAUSES
  Close the black Margin window and start "Start Margin.bat" again (this lets the
  voice use all CPU cores). If it still pauses, switch CPU to GPU in the bottom bar.

WHERE THINGS ARE SAVED
  Books, highlights and notes are saved inside your browser (Chrome/Edge),
  for this address only. Use the same browser each time.
  Clearing browser data for localhost will erase them - export notes regularly.

Built with PDF.js (Apache 2.0, see lib/pdfjs/LICENSE) and Kokoro-82M (Apache 2.0).
