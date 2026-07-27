import SwiftUI

/// A block in a day or week timeline.
///
/// Tinted fill plus a solid leading rail in the calendar's own color: it reads
/// at a glance in a dense column, and it keeps the color identity of the source
/// calendar without drowning the text.
struct EventChip: View {
    let item: CalendarItem
    var height: CGFloat

    private var color: Color { Color(hex: item.colorHex) }

    /// Below roughly two lines of type there is no room for anything but the
    /// title, so the chip drops its detail line rather than clipping it.
    private var showsDetail: Bool { height >= 34 }

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            if item.origin.isTask {
                Image(systemName: item.isCompleted ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 9, weight: .semibold))
                    .padding(.top, 1)
            }

            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(Theme.Typography.chipTitle)
                    .lineLimit(showsDetail ? 2 : 1)
                    .strikethrough(item.isCompleted, color: color.opacity(0.7))

                if showsDetail {
                    HStack(spacing: 3) {
                        Text(DateFormat.compactTime.string(from: item.start))
                        if item.hasInferredTime {
                            // The time is the app's guess, not the user's.
                            Image(systemName: "questionmark.circle")
                                .font(.system(size: 8, weight: .semibold))
                        }
                    }
                    .font(Theme.Typography.chipDetail)
                    .opacity(0.75)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(color)
        .background(color.opacity(item.hasInferredTime ? 0.09 : 0.16))
        .overlay(alignment: .leading) {
            Rectangle().fill(color).frame(width: 2.5)
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.chipCornerRadius, style: .continuous))
        .overlay {
            // A dashed outline marks a block whose time the app supplied, so a
            // stack of defaulted tasks does not read as a stack of real
            // commitments.
            if item.hasInferredTime {
                RoundedRectangle(cornerRadius: Theme.Metrics.chipCornerRadius, style: .continuous)
                    .strokeBorder(color.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            }
        }
        .opacity(item.isCompleted ? 0.55 : 1)
        .contentShape(Rectangle())
    }
}

/// A row in the agenda list under the month grid.
struct AgendaRow: View {
    let item: CalendarItem
    var onToggleCompletion: (() -> Void)?

    private var color: Color { Color(hex: item.colorHex) }

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(color)
                .frame(width: Theme.Metrics.agendaRailWidth)
                .frame(maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if item.origin.isTask, let onToggleCompletion {
                        Button(action: onToggleCompletion) {
                            Image(systemName: item.isCompleted ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(item.isCompleted ? color : .secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(item.isCompleted ? "Mark incomplete" : "Mark complete")
                    }

                    Text(item.title)
                        .font(Theme.Typography.agendaTitle)
                        .strikethrough(item.isCompleted, color: .secondary)
                        .foregroundStyle(item.isCompleted ? .secondary : .primary)

                    if item.isRecurring {
                        Image(systemName: "repeat")
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                    }
                }

                HStack(spacing: 6) {
                    // Saying "no time" is more honest than showing a range the
                    // user never chose.
                    Text(
                        item.hasInferredTime
                            ? "No time · \(DateFormat.time.string(from: item.start))"
                            : DateFormat.range(item)
                    )
                    Text("·")
                    Text(item.containerTitle)
                    if let location = item.location, !location.isEmpty {
                        Text("·")
                        Image(systemName: "mappin.and.ellipse").font(.system(size: 9))
                        Text(location).lineLimit(1)
                    }
                }
                .font(Theme.Typography.agendaDetail)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}

/// Empty-state used by the agenda and day views.
struct EmptyDayView: View {
    var message: String = "Nothing scheduled"

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.tertiary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}
