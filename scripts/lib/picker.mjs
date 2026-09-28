/**
 * Search-then-choose prompt shared by the interactive runners.
 *
 * Flow: type a keyword → the matches are listed and numbered → pick from that
 * list. Numbering always restarts at 1 over the FILTERED set, so you choose
 * from what you just searched rather than from the full catalogue.
 *
 * @param {object} opts
 * @param {string[]} opts.items          the values to choose from
 * @param {(q: string) => Promise<string>} opts.ask
 * @param {(s: string) => void} [opts.print]
 * @param {string} [opts.noun]           e.g. 'competency' (used in the prompts)
 * @param {string} [opts.where]          e.g. 'BNRC · हिंदी' (shown in the header)
 * @param {number} [opts.pageSize]
 * @param {boolean} [opts.multi]         allow "1,3" and "all"
 * @returns {Promise<string[]>} the chosen values
 */
export async function chooseFrom({
  items, ask, print = console.log, noun = 'item', where = '', pageSize = 30, multi = false,
}) {
  let filter = '';
  let matches = items;
  let shown = [];
  let showAll = false;

  const show = () => {
    shown = showAll ? matches : matches.slice(0, pageSize);
    if (!matches.length) {
      print(`\n  ✖ No ${noun} matches "${filter}" — try a shorter keyword.`);
      return;
    }
    print(`\n🧗 ${matches.length} ${noun}${matches.length === 1 ? '' : 's'}` +
      `${filter ? ` matching "${filter}"` : ''} — choose from the list:\n`);
    shown.forEach((t, i) => print(`  ${String(i + 1).padStart(3)}. ${t}`));
    if (matches.length > shown.length) {
      print(`\n  … and ${matches.length - shown.length} more — narrow the search, or type "more" to list them all.`);
    }
  };

  const search = (term) => {
    filter = (term ?? '').trim();
    showAll = false;
    matches = filter ? items.filter((t) => t.toLowerCase().includes(filter.toLowerCase())) : items;
    show();
  };

  print(`\n🔎 ${items.length} ${noun}${items.length === 1 ? '' : 's'} available${where ? ` (${where})` : ''}.`);
  search(await ask(`\n  Search for a ${noun} (keyword, or Enter to list all) : `));

  for (;;) {
    if (!matches.length) { search(await ask('\n  Search again : ')); continue; }

    const only = shown.length === 1 ? ` — Enter picks "${shown[0]}"` : '';
    const sel = await ask(
      `\n  👉 Choose ${multi ? 'number(s) e.g. 3 or 1,4,7' : 'a number'}${only}` +
        `\n     (or type a new keyword to search  ·  "more"${multi ? '  ·  "all"' : ''}) : `,
    );

    if (!sel) {
      if (shown.length === 1) return [shown[0]];
      show();
      continue;
    }
    if (sel.toLowerCase() === 'more') { showAll = true; show(); continue; }
    if (multi && sel.toLowerCase() === 'all') {
      if (shown.length > 5) {
        const ok = await ask(`  Run all ${shown.length} listed ${noun}s one after another? (y/N) : `);
        if (!/^y/i.test(ok)) continue;
      }
      return [...shown];
    }

    const pattern = multi ? /^\d+(\s*,\s*\d+)*$/ : /^\d+$/;
    if (pattern.test(sel)) {
      const picked = [];
      let bad = false;
      for (const part of sel.split(',')) {
        const n = Number(part.trim());
        if (n < 1 || n > shown.length) { print(`  ✖ ${n} is not in the list above.`); bad = true; break; }
        picked.push(shown[n - 1]);
      }
      if (bad) continue;
      return picked;
    }

    // Anything else is a fresh search term.
    search(sel);
  }
}

/** Single-choice convenience wrapper. */
export async function chooseOne(opts) {
  const [picked] = await chooseFrom({ ...opts, multi: false });
  return picked;
}
