// Compat shim — uses only functions present in older plugin v01.10.x
#include <cstring>
#include <functional>
#include <map>
#include <string>
#include <vector>

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
    int   bambu_network_send_message(void* agent, std::string dev_id, std::string json_str, int qos);
    int   bambu_network_change_user(void* agent, std::string user_info);
    bool  bambu_network_is_user_login(void* agent);
    int   bambu_network_get_user_print_info(void* agent, unsigned int* http_code, std::string* http_body);
    int   bambu_network_set_user_selected_machine(void* agent, std::string dev_id);
    int   bambu_network_add_subscribe(void* agent, std::vector<std::string> dev_list);
    int   bambu_network_start_subscribe(void* agent, std::string module);
    void  bambu_network_enable_multi_machine(void* agent, bool enable);
    int   bambu_network_set_extra_http_header(void* agent, std::map<std::string,std::string> hdrs);

    using OnUserLoginFn        = std::function<void(int, bool)>;
    using OnServerConnectedFn  = std::function<void(int, int)>;
    using OnPrinterConnectedFn = std::function<void(std::string)>;
    using OnMessageFn          = std::function<void(std::string, std::string)>;
    using OnHttpErrorFn        = std::function<void(unsigned, std::string)>;
    using GetCountryCodeFn     = std::function<std::string()>;

    int bambu_network_set_on_user_login_fn(void*, OnUserLoginFn);
    int bambu_network_set_on_server_connected_fn(void*, OnServerConnectedFn);
    int bambu_network_set_on_printer_connected_fn(void*, OnPrinterConnectedFn);
    int bambu_network_set_on_message_fn(void*, OnMessageFn);
    int bambu_network_set_on_http_error_fn(void*, OnHttpErrorFn);
    int bambu_network_set_get_country_code_fn(void*, GetCountryCodeFn);
}

extern "C" {

void* shim_create_agent(const char* d)             { return bambu_network_create_agent(std::string(d?d:"")); }
int   shim_destroy_agent(void* a)                  { return bambu_network_destroy_agent(a); }
int   shim_init_log(void* a)                       { return bambu_network_init_log(a); }
int   shim_set_config_dir(void* a, const char* d)  { return bambu_network_set_config_dir(a, std::string(d?d:"")); }
int   shim_set_country_code(void* a, const char* c){ return bambu_network_set_country_code(a, std::string(c?c:"")); }
int   shim_set_cert_file(void* a, const char* f, const char* fn) { return bambu_network_set_cert_file(a, std::string(f?f:""), std::string(fn?fn:"")); }
int   shim_start(void* a)                          { return bambu_network_start(a); }
int   shim_connect_server(void* a)                 { return bambu_network_connect_server(a); }
int   shim_is_server_connected(void* a)            { return bambu_network_is_server_connected(a) ? 1 : 0; }
int   shim_send_message(void* a, const char* d, const char* j, int qos) {
    return bambu_network_send_message(a, std::string(d?d:""), std::string(j?j:""), qos);
}
int   shim_change_user(void* a, const char* j)     { return bambu_network_change_user(a, std::string(j?j:"")); }
int   shim_is_user_login(void* a)                  { return bambu_network_is_user_login(a) ? 1 : 0; }
int   shim_get_user_print_info(void* a, char* out, int sz) {
    unsigned int hc = 0; std::string body;
    int rc = bambu_network_get_user_print_info(a, &hc, &body);
    if (out && sz > 0) {
        size_t n = body.size() < (size_t)(sz-1) ? body.size() : (size_t)(sz-1);
        std::memcpy(out, body.data(), n); out[n] = 0;
    }
    return rc < 0 ? rc : (int)hc;
}
int   shim_set_user_selected_machine(void* a, const char* d) { return bambu_network_set_user_selected_machine(a, std::string(d?d:"")); }
int   shim_add_subscribe_one(void* a, const char* d) {
    std::vector<std::string> v; if (d) v.push_back(std::string(d));
    return bambu_network_add_subscribe(a, v);
}
int   shim_start_subscribe(void* a, const char* m) { return bambu_network_start_subscribe(a, std::string(m?m:"")); }
void  shim_enable_multi_machine(void* a, int e)    { bambu_network_enable_multi_machine(a, e!=0); }
int   shim_set_extra_http_headers(void* a, const char* const* kv, int n) {
    std::map<std::string,std::string> m;
    for (int i = 0; i < n; ++i) {
        const char* k = kv[i*2]; const char* v = kv[i*2+1];
        if (k && v) m[std::string(k)] = std::string(v);
    }
    return bambu_network_set_extra_http_header(a, m);
}

// Callbacks
typedef void (*c_on_user_login)(int, int);
typedef void (*c_on_server_connected)(int, int);
typedef void (*c_on_printer_connected)(const char*);
typedef void (*c_on_message)(const char*, const char*);
typedef void (*c_on_http_error)(unsigned, const char*);

static c_on_user_login        g_ul = nullptr;
static c_on_server_connected  g_sc = nullptr;
static c_on_printer_connected g_pc = nullptr;
static c_on_message           g_m  = nullptr;
static c_on_http_error        g_he = nullptr;
static char                   g_country[8] = "US";

int shim_set_on_user_login_fn(void* a, c_on_user_login cb) {
    g_ul = cb;
    return bambu_network_set_on_user_login_fn(a, [](int o, bool l){ if(g_ul) g_ul(o, l?1:0); });
}
int shim_set_on_server_connected_fn(void* a, c_on_server_connected cb) {
    g_sc = cb;
    return bambu_network_set_on_server_connected_fn(a, [](int rc, int rs){ if(g_sc) g_sc(rc, rs); });
}
int shim_set_on_printer_connected_fn(void* a, c_on_printer_connected cb) {
    g_pc = cb;
    return bambu_network_set_on_printer_connected_fn(a, [](std::string t){ if(g_pc) g_pc(t.c_str()); });
}
int shim_set_on_message_fn(void* a, c_on_message cb) {
    g_m = cb;
    return bambu_network_set_on_message_fn(a, [](std::string d, std::string m){ if(g_m) g_m(d.c_str(), m.c_str()); });
}
int shim_set_on_http_error_fn(void* a, c_on_http_error cb) {
    g_he = cb;
    return bambu_network_set_on_http_error_fn(a, [](unsigned hc, std::string b){ if(g_he) g_he(hc, b.c_str()); });
}
int shim_set_country_code_callback(void* a, const char* c) {
    if (c) { std::strncpy(g_country, c, 7); g_country[7] = 0; }
    return bambu_network_set_get_country_code_fn(a, [](){ return std::string(g_country); });
}

} // extern "C"
