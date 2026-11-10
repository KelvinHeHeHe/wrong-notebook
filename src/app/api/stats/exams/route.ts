import { NextResponse } from "next/server";

import { withUser } from "@/lib/api-handler";
import { getExamTrendStats } from "@/lib/stats/exam-trends";
import { parseStatsRange } from "@/lib/stats/stats-range";

import type { AuthenticatedContext } from "@/lib/api-handler";

export const GET = withUser(async (req: Request, { user }: AuthenticatedContext) => {
    const url = new URL(req.url);
    return NextResponse.json(await getExamTrendStats({
        userId: user.id,
        range: parseStatsRange(url.searchParams.get('range'), '90d'),
        subjectIdParam: url.searchParams.get('subjectId'),
    }));
});
