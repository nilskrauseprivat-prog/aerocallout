import Foundation
import WebKit

/// Serves the bundled web app at aerocallout://app/www/... and contains the built-in ADS-B proxy
/// (aerocallout://app/www/proxy/<source>/<path>): the open ADS-B APIs send no CORS headers, a native request needs none.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "aerocallout"
    static let startURL = URL(string: "aerocallout://app/www/index.html")!

    private static let proxyHosts = [
        "adsblol": "https://api.adsb.lol",
        "adsbfi": "https://opendata.adsb.fi/api",
    ]
    private static let mime = [
        "html": "text/html", "js": "text/javascript", "css": "text/css", "json": "application/json",
        "webmanifest": "application/manifest+json", "svg": "image/svg+xml", "png": "image/png",
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "ico": "image/x-icon", "txt": "text/plain", "md": "text/plain",
        "woff2": "font/woff2", "wav": "audio/wav", "mp3": "audio/mpeg",
    ]

    private let root: URL = Bundle.main.resourceURL!.appendingPathComponent("www", isDirectory: true)
    private var active = Set<ObjectIdentifier>()      // tasks not yet stopped by WebKit (main thread only)
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 7
        c.timeoutIntervalForResource = 8
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpAdditionalHeaders = ["User-Agent": "AeroCallout/0.3 (open-source traffic awareness; iOS)"]
        return URLSession(configuration: c)
    }()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        active.insert(ObjectIdentifier(task as AnyObject))
        guard let url = task.request.url else { fail(task, 400); return }
        let path = url.path
        if path.hasPrefix("/www/proxy/") {
            proxy(task, String(path.dropFirst("/www/proxy/".count)), query: url.query)
            return
        }
        guard path.hasPrefix("/www/") else { fail(task, 404); return }
        var rel = String(path.dropFirst("/www/".count))
        if rel.isEmpty { rel = "index.html" }
        if rel.contains("..") { fail(task, 403); return }
        let file = root.appendingPathComponent(rel)
        guard let data = try? Data(contentsOf: file) else { fail(task, 404); return }
        let type = SchemeHandler.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"
        respond(task, 200, type, data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task as AnyObject))
    }

    // MARK: - ADS-B proxy

    private func proxy(_ task: WKURLSchemeTask, _ rest: String, query: String?) {
        guard let slash = rest.firstIndex(of: "/"),
              let base = SchemeHandler.proxyHosts[String(rest[..<slash])] else { fail(task, 404); return }
        let sub = String(rest[rest.index(after: slash)...])
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/._-")
        guard !sub.isEmpty, sub.unicodeScalars.allSatisfy({ allowed.contains($0) }),
              let target = URL(string: base + "/" + sub) else { fail(task, 404); return }
        session.dataTask(with: target) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let http = resp as? HTTPURLResponse {
                    self.respond(task, http.statusCode, "application/json", data ?? Data())
                } else {
                    self.fail(task, 502)
                }
            }
        }.resume()
    }

    // MARK: - responses (main thread)

    private func respond(_ task: WKURLSchemeTask, _ code: Int, _ type: String, _ data: Data) {
        guard active.contains(ObjectIdentifier(task as AnyObject)), let url = task.request.url else { return }
        let headers = [
            "Content-Type": type,
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        ]
        guard let r = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
        task.didReceive(r)
        task.didReceive(data)
        task.didFinish()
        active.remove(ObjectIdentifier(task as AnyObject))
    }

    private func fail(_ task: WKURLSchemeTask, _ code: Int) {
        respond(task, code, "text/plain", Data())
    }
}
