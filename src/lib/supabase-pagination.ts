const DEFAULT_PAGE_SIZE = 1000;

export async function fetchAllSupabasePages<T>(
  createQuery: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await createQuery().range(from, to);
    if (error) throw new Error(error.message);

    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return rows;
}
