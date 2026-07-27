import Foundation

/// Works out how overlapping items share the horizontal space in a day or week
/// column.
///
/// This is the arrangement every calendar app converges on: items that overlap
/// are split into side-by-side columns, and the number of columns is decided per
/// *cluster* of mutually overlapping items rather than per day. That way one
/// busy hour in the morning does not squeeze the rest of the day into a sliver.
public enum TimelineLayout {
    public struct Placement: Equatable {
        /// Zero-based column this item occupies.
        public let column: Int
        /// How many columns its cluster was split into. Width is `1 / columnCount`.
        public let columnCount: Int

        public init(column: Int, columnCount: Int) {
            self.column = column
            self.columnCount = columnCount
        }
    }

    /// Items shorter than this still reserve a full slot for overlap purposes,
    /// so a zero-length item does not silently stack underneath its neighbour.
    public static let minimumLayoutDuration: TimeInterval = 15 * 60

    /// Returns a placement per item id.
    ///
    /// `items` may contain all-day items and items from neighbouring days; both
    /// are filtered out here so callers can hand over an unfiltered day bucket.
    public static func place(
        _ items: [CalendarItem],
        on day: Date,
        calendar: Calendar
    ) -> [String: Placement] {
        let timed = items
            .filter { !$0.isAllDay && $0.occurs(on: day, calendar: calendar) }
            .map { item -> (id: String, start: Date, end: Date) in
                let clamped = item.clamped(to: day, calendar: calendar)
                let end = max(clamped.end, clamped.start.addingTimeInterval(minimumLayoutDuration))
                return (item.id, clamped.start, end)
            }
            // Longer items first at equal start times so the big block takes the
            // leftmost column and the short ones tuck in beside it. The id is a
            // final tiebreak purely to keep the output stable between runs.
            .sorted {
                if $0.start != $1.start { return $0.start < $1.start }
                if $0.end != $1.end { return $0.end > $1.end }
                return $0.id < $1.id
            }

        guard !timed.isEmpty else { return [:] }

        var placements: [String: Placement] = [:]

        // A cluster is a run of items connected by overlap. It ends as soon as
        // an item starts at or after everything before it has finished.
        var clusterStartIndex = 0
        var clusterEnd = timed[0].end
        // Per column, the end date of the last item placed in it.
        var columnEnds: [Date] = []
        var assignedColumns: [Int] = []

        func flushCluster(upTo endIndex: Int) {
            let columnCount = max(columnEnds.count, 1)
            for index in clusterStartIndex..<endIndex {
                placements[timed[index].id] = Placement(
                    column: assignedColumns[index - clusterStartIndex],
                    columnCount: columnCount
                )
            }
        }

        for (index, item) in timed.enumerated() {
            if index > clusterStartIndex && item.start >= clusterEnd {
                // No overlap with anything in the current cluster: close it out.
                flushCluster(upTo: index)
                clusterStartIndex = index
                clusterEnd = item.end
                columnEnds = []
                assignedColumns = []
            }

            // Reuse the leftmost column whose previous occupant has finished.
            let column = columnEnds.firstIndex { $0 <= item.start } ?? columnEnds.count
            if column == columnEnds.count {
                columnEnds.append(item.end)
            } else {
                columnEnds[column] = item.end
            }
            assignedColumns.append(column)
            clusterEnd = max(clusterEnd, item.end)
        }

        flushCluster(upTo: timed.count)
        return placements
    }
}
