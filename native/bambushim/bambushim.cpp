// bambushim — extern "C" wrapper around Bambu's libbambu_networking.
//
// Why this exists: the plugin's exported functions take std::string by value,
// which is a C++ ABI we can't construct from Node.js FFI without knowing the
// exact libstdc++/libc++ layout. This shim is compiled with the same C++ stdlib
// as the plugin and forwards C-friendly calls (const char*) into it.
//
// Build (Mac, both archs):
//   clang++ -std=c++17 -shared -fPIC -arch arm64 -arch x86_64 \
//     -o libbambushim.dylib bambushim.cpp \
//     -L../../vendor/bambu/mac -lbambu_networking \
//     -Wl,-rpath,@loader_path/../../vendor/bambu/mac
//
// Build (Linux):
//   g++ -std=c++17 -shared -fPIC \
//     -o libbambushim.so bambushim.cpp \
//     -L../../vendor/bambu/linux -lbambu_networking \
//     -Wl,-rpath,'$ORIGIN/../../vendor/bambu/linux'

#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

// ── Plugin function signatures (verbatim from BambuStudio NetworkAgent.hpp) ──
// We declare them with extern "C" linkage to match the symbol names in the .so/
// .dylib (the plugin uses extern "C" for these).
extern "C" {
    void* bambu_network_create_agent(std::string log_dir);
    int   bambu_network_destroy_agent(void* agent);
    int   bambu_network_init_log(void* agent);
    int   bambu_network_set_config_dir(void* agent, std::string config_dir);
    int   bambu_network_set_country_code(void* agent, std::string country_code);
    int   bambu_network_set_cert_file(void* agent, std::string folder, std::string filename);
    int   bambu_network_start(void* agent);
    int   bambu_network_connect_server(void* agent);
    bool  bambu_network_is_server_connected(void* agent);
    int   bambu_network_connect_printer(void* agent, std::string dev_id, std::string dev_ip,
                                        std::string username, std::string password, bool use_ssl);
    int   bambu_network_disconnect_printer(void* agent);
    int   bambu_network_send_message(void* agent, std::string dev_id, std::string json_str,
                                     int qos, int flag);
    int   bambu_network_send_message_to_printer(void* agent, std::string dev_id, std::string json_str,
                                                int qos, int flag);
    int   bambu_network_get_my_token(void* agent, std::string ticket,
                                     unsigned int* http_code, std::string* http_body);
    void  bambu_network_install_device_cert(void* agent, std::string dev_id, bool lan_only);
    bool  bambu_network_is_user_login(void* agent);
    int   bambu_network_refresh_connection(void* agent);
    int   bambu_network_get_my_profile(void* agent, std::string token, unsigned int* http_code, std::string* http_body);
    int   bambu_network_change_user(void* agent, std::string user_info);
    // NOTE: set_extra_http_header takes std::map<std::string,std::string> — not
    // FFI-friendly, omitted from the shim. If we ever need extra headers we'll
    // either build a map-construction helper here or skip the plugin's HTTP
    // entirely and inject creds via the config-dir file route.

    // Callback setters take std::function<>. We bind plain C function pointers
    // through std::function lambdas in the shim wrappers further down.
    using OnUserLoginFn        = std::function<void(int online_login, bool login)>;
    using OnServerConnectedFn  = std::function<void(int return_code, int reason_code)>;
    using OnPrinterConnectedFn = std::function<void(std::string topic_str)>;
    using OnMessageFn          = std::function<void(std::string dev_id, std::string msg)>;
    using OnHttpErrorFn        = std::function<void(unsigned http_code, std::string http_body)>;
    using GetCountryCodeFn     = std::function<std::string()>;

    int bambu_network_set_on_user_login_fn(void* agent, OnUserLoginFn fn);
    int bambu_network_set_on_server_connected_fn(void* agent, OnServerConnectedFn fn);
    int bambu_network_set_on_printer_connected_fn(void* agent, OnPrinterConnectedFn fn);
    int bambu_network_set_on_message_fn(void* agent, OnMessageFn fn);
    int bambu_network_set_on_http_error_fn(void* agent, OnHttpErrorFn fn);
    int bambu_network_set_get_country_code_fn(void* agent, GetCountryCodeFn fn);

    int  bambu_network_start_subscribe(void* agent, std::string module);
    int  bambu_network_stop_subscribe(void* agent, std::string module);
    void bambu_network_enable_multi_machine(void* agent, bool enable);
    int  bambu_network_add_subscribe(void* agent, std::vector<std::string> dev_list);
    int  bambu_network_del_subscribe(void* agent, std::vector<std::string> dev_list);
}

// ── C-friendly wrapper API exposed to Node.js FFI ────────────────────────────
extern "C" {

void* shim_create_agent(const char* log_dir) {
    return bambu_network_create_agent(std::string(log_dir ? log_dir : ""));
}

int shim_destroy_agent(void* agent) {
    return bambu_network_destroy_agent(agent);
}

int shim_init_log(void* agent) {
    return bambu_network_init_log(agent);
}

int shim_set_config_dir(void* agent, const char* dir) {
    return bambu_network_set_config_dir(agent, std::string(dir ? dir : ""));
}

int shim_set_country_code(void* agent, const char* code) {
    return bambu_network_set_country_code(agent, std::string(code ? code : ""));
}

int shim_set_cert_file(void* agent, const char* folder, const char* filename) {
    return bambu_network_set_cert_file(agent,
        std::string(folder ? folder : ""),
        std::string(filename ? filename : ""));
}

int shim_start(void* agent) {
    return bambu_network_start(agent);
}

int shim_connect_server(void* agent) {
    return bambu_network_connect_server(agent);
}

int shim_is_server_connected(void* agent) {
    return bambu_network_is_server_connected(agent) ? 1 : 0;
}

int shim_connect_printer(void* agent, const char* dev_id, const char* dev_ip,
                          const char* username, const char* password, int use_ssl) {
    return bambu_network_connect_printer(agent,
        std::string(dev_id ? dev_id : ""),
        std::string(dev_ip ? dev_ip : ""),
        std::string(username ? username : ""),
        std::string(password ? password : ""),
        use_ssl != 0);
}

int shim_disconnect_printer(void* agent) {
    return bambu_network_disconnect_printer(agent);
}

int shim_send_message(void* agent, const char* dev_id, const char* json_str,
                       int qos, int flag) {
    return bambu_network_send_message(agent,
        std::string(dev_id ? dev_id : ""),
        std::string(json_str ? json_str : ""),
        qos, flag);
}

// Legacy (4-arg, no flag) variant — older plugins use this ABI
extern "C" int bambu_network_send_message_legacy(void* agent, std::string dev_id,
                                                 std::string json_str, int qos)
    __asm__("_bambu_network_send_message");
int shim_send_message_legacy(void* agent, const char* dev_id, const char* json_str, int qos) {
    return bambu_network_send_message_legacy(agent,
        std::string(dev_id ? dev_id : ""),
        std::string(json_str ? json_str : ""),
        qos);
}

int shim_send_message_to_printer(void* agent, const char* dev_id, const char* json_str,
                                  int qos, int flag) {
    return bambu_network_send_message_to_printer(agent,
        std::string(dev_id ? dev_id : ""),
        std::string(json_str ? json_str : ""),
        qos, flag);
}

void shim_install_device_cert(void* agent, const char* dev_id, int lan_only) {
    bambu_network_install_device_cert(agent,
        std::string(dev_id ? dev_id : ""),
        lan_only != 0);
}

int shim_is_user_login(void* agent) {
    return bambu_network_is_user_login(agent) ? 1 : 0;
}

// Inject pre-existing credentials into the plugin without going through the
// OAuth flow. The user_info JSON format was reverse-engineered from
// OrcaSlicer's HttpServer.cpp bbl_auth_handle_request():
//   { "data": { "token": ACCESS, "refresh_token": REFRESH,
//               "expires_in": "...", "refresh_expires_in": "...",
//               "user": { "uid": "...", "name": "...",
//                         "account": "...", "avatar": "" } } }
int shim_change_user(void* agent, const char* user_info_json) {
    return bambu_network_change_user(agent,
        std::string(user_info_json ? user_info_json : ""));
}

int shim_refresh_connection(void* agent) {
    return bambu_network_refresh_connection(agent);
}

// Out-string is returned via a 64KB caller-allocated buffer to avoid
// std::string ABI on the boundary. Returns http_code; -1 on error.
int shim_get_my_profile(void* agent, const char* token, char* out_body, int out_body_size) {
    unsigned int http_code = 0;
    std::string body;
    int rc = bambu_network_get_my_profile(agent,
        std::string(token ? token : ""),
        &http_code, &body);
    if (out_body && out_body_size > 0) {
        size_t n = body.size() < (size_t)(out_body_size - 1) ? body.size() : (out_body_size - 1);
        std::memcpy(out_body, body.data(), n);
        out_body[n] = 0;
    }
    return rc < 0 ? rc : (int)http_code;
}

// ── Callback bridging ────────────────────────────────────────────────────────
// Plugin callbacks are std::function<> which can't be constructed from JS.
// The shim accepts plain C function pointers and wraps them in lambdas that
// satisfy the std::function signature. Globals hold the C pointers so the
// lambda captures stay valid for the lifetime of the process.

typedef void (*c_on_user_login)(int online_login, int login);
typedef void (*c_on_server_connected)(int return_code, int reason_code);
typedef void (*c_on_printer_connected)(const char* topic);
typedef void (*c_on_message)(const char* dev_id, const char* msg);
typedef void (*c_on_http_error)(unsigned http_code, const char* body);

static c_on_user_login        g_on_user_login        = nullptr;
static c_on_server_connected  g_on_server_connected  = nullptr;
static c_on_printer_connected g_on_printer_connected = nullptr;
static c_on_message           g_on_message           = nullptr;
static c_on_http_error        g_on_http_error        = nullptr;
static char                   g_country_code[8]      = "US";

int shim_set_on_user_login_fn(void* agent, c_on_user_login cb) {
    g_on_user_login = cb;
    OnUserLoginFn fn = [](int online_login, bool login) {
        if (g_on_user_login) g_on_user_login(online_login, login ? 1 : 0);
    };
    return bambu_network_set_on_user_login_fn(agent, fn);
}

int shim_set_on_server_connected_fn(void* agent, c_on_server_connected cb) {
    g_on_server_connected = cb;
    OnServerConnectedFn fn = [](int return_code, int reason_code) {
        if (g_on_server_connected) g_on_server_connected(return_code, reason_code);
    };
    return bambu_network_set_on_server_connected_fn(agent, fn);
}

int shim_set_on_printer_connected_fn(void* agent, c_on_printer_connected cb) {
    g_on_printer_connected = cb;
    OnPrinterConnectedFn fn = [](std::string topic) {
        if (g_on_printer_connected) g_on_printer_connected(topic.c_str());
    };
    return bambu_network_set_on_printer_connected_fn(agent, fn);
}

int shim_set_on_message_fn(void* agent, c_on_message cb) {
    g_on_message = cb;
    OnMessageFn fn = [](std::string dev_id, std::string msg) {
        if (g_on_message) g_on_message(dev_id.c_str(), msg.c_str());
    };
    return bambu_network_set_on_message_fn(agent, fn);
}

int shim_set_on_http_error_fn(void* agent, c_on_http_error cb) {
    g_on_http_error = cb;
    OnHttpErrorFn fn = [](unsigned http_code, std::string body) {
        if (g_on_http_error) g_on_http_error(http_code, body.c_str());
    };
    return bambu_network_set_on_http_error_fn(agent, fn);
}

int shim_start_subscribe(void* agent, const char* module) {
    return bambu_network_start_subscribe(agent, std::string(module ? module : ""));
}

int shim_stop_subscribe(void* agent, const char* module) {
    return bambu_network_stop_subscribe(agent, std::string(module ? module : ""));
}

void shim_enable_multi_machine(void* agent, int enable) {
    bambu_network_enable_multi_machine(agent, enable != 0);
}

int shim_add_subscribe_one(void* agent, const char* dev_id) {
    std::vector<std::string> v;
    if (dev_id) v.push_back(std::string(dev_id));
    return bambu_network_add_subscribe(agent, v);
}

int shim_del_subscribe_one(void* agent, const char* dev_id) {
    std::vector<std::string> v;
    if (dev_id) v.push_back(std::string(dev_id));
    return bambu_network_del_subscribe(agent, v);
}

// Country-code callback is sync — plugin calls and expects a string back.
// We hold it in a static buffer.
int shim_set_country_code_callback(void* agent, const char* code) {
    if (code) {
        std::strncpy(g_country_code, code, sizeof(g_country_code) - 1);
        g_country_code[sizeof(g_country_code) - 1] = 0;
    }
    GetCountryCodeFn fn = []() { return std::string(g_country_code); };
    return bambu_network_set_get_country_code_fn(agent, fn);
}

} // extern "C"
