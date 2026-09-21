/**
 * Mstar 糖果商城 - 前後台整合系統 (Vue 3 + 原生 SQLite 後端 + 登入防護 + Discord 通知)
 */

const { createApp, ref, reactive, computed, watch, onMounted } = Vue;

const STORAGE_KEYS = {
  CART: 'mstar.cart',
  BUYER: 'mstar.buyer',
  AUTH: 'mstar.auth_user'
};

const GENDER_OPTIONS = [
  { value: 'male', label: '男角', icon: '♂' },
  { value: 'female', label: '女角', icon: '♀' }
];

const CONTACT_SPECS = {
  game: {
    kind: 'game',
    label: '遊戲 ID',
    short: '遊戲',
    copyHint: '去遊戲裡密語賣家吧！',
    chipClass: 'bg-mint-500/15 text-mint-300 border-mint-500/35'
  },
  discord: {
    kind: 'discord',
    label: 'DC ID',
    short: 'DC',
    copyHint: '去 Discord 找他吧！',
    chipClass: 'bg-[#5865F2]/20 text-[#b3baff] border-[#5865F2]/45'
  }
};

function formatNumber(num) {
  return new Intl.NumberFormat('zh-TW').format(num || 0);
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d);
}

async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

createApp({
  setup() {
    // ------------------------------------------------------------------------
    // 1. 身分驗證與登入狀態 (含密碼防入侵鎖定計時)
    // ------------------------------------------------------------------------
    function loadInitialUser() {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.AUTH);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    const currentUser = ref(loadInitialUser());
    const isLoggedIn = computed(() => !!currentUser.value);
    const showLoginModal = ref(false);
    const lockRemaining = ref(0); // 鎖定剩餘秒數
    let lockTimer = null;

    const loginForm = reactive({
      username: '',
      password: '',
      error: '',
      loading: false
    });

    function startLockCountdown(seconds) {
      lockRemaining.value = seconds;
      if (lockTimer) clearInterval(lockTimer);
      lockTimer = setInterval(() => {
        lockRemaining.value -= 1;
        if (lockRemaining.value <= 0) {
          clearInterval(lockTimer);
          lockTimer = null;
          loginForm.error = '';
        }
      }, 1000);
    }

    async function handleLogin() {
      if (lockRemaining.value > 0) return;
      loginForm.error = '';

      if (!loginForm.username.trim() || !loginForm.password) {
        loginForm.error = '請輸入帳號與密碼';
        return;
      }

      loginForm.loading = true;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: loginForm.username.trim(),
            password: loginForm.password
          })
        });
        const data = await res.json();
        if (res.ok && data.user) {
          currentUser.value = data.user;
          localStorage.setItem(STORAGE_KEYS.AUTH, JSON.stringify(data.user));
          showLoginModal.value = false;
          loginForm.username = '';
          loginForm.password = '';
          toast.success(`歡迎回來，${data.user.display_name}！`);
          setView('admin');
        } else {
          loginForm.error = data.error || '登入失敗，請確認帳號密碼';
          if (data.remainingSeconds) {
            startLockCountdown(data.remainingSeconds);
          }
        }
      } catch (err) {
        loginForm.error = '伺服器連線失敗';
      } finally {
        loginForm.loading = false;
      }
    }

    function handleLogout() {
      currentUser.value = null;
      localStorage.removeItem(STORAGE_KEYS.AUTH);
      toast.info('已成功登出');
      setView('shop');
    }

    // ------------------------------------------------------------------------
    // 2. 導覽分頁與視圖控制
    // ------------------------------------------------------------------------
    const currentView = ref('shop'); // 'shop' | 'cart' | 'admin'
    const adminTab = ref('create');  // 'create' | 'products' | 'users' | 'orders' | 'discord'
    const mobileMenuOpen = ref(false);

    function setView(view) {
      if (view === 'admin' && !isLoggedIn.value) {
        showLoginModal.value = true;
        toast.info('請先登入賣家或管理員帳號');
        return;
      }
      currentView.value = view;
      window.location.hash = view;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      mobileMenuOpen.value = false;
    }

    onMounted(() => {
      const hash = window.location.hash.replace('#', '');
      if (['shop', 'cart', 'admin'].includes(hash)) {
        if (hash === 'admin' && !isLoggedIn.value) {
          currentView.value = 'shop';
        } else {
          currentView.value = hash;
        }
      }
      fetchData();
    });

    // ------------------------------------------------------------------------
    // 3. Toast 通知系統
    // ------------------------------------------------------------------------
    const toasts = ref([]);
    let toastCounter = 0;
    function showToast(message, kind = 'info', duration = 3000) {
      const id = ++toastCounter;
      toasts.value.push({ id, kind, message });
      setTimeout(() => {
        toasts.value = toasts.value.filter(t => t.id !== id);
      }, duration);
    }
    const toast = {
      info: (m) => showToast(m, 'info', 3000),
      success: (m) => showToast(m, 'success', 3500),
      error: (m) => showToast(m, 'error', 4200)
    };
    function dismissToast(id) {
      toasts.value = toasts.value.filter(t => t.id !== id);
    }

    // ------------------------------------------------------------------------
    // 4. 資料庫資料拉取
    // ------------------------------------------------------------------------
    const sellers = ref([]);
    const usersList = ref([]);
    const categories = ref([]);
    const products = ref([]);
    const orders = ref([]);
    const discordWebhookUrl = ref('');
    const loadingProducts = ref(false);

    async function fetchData() {
      await Promise.all([
        loadSellers(),
        loadCategories(),
        loadProducts(),
        loadUsers(),
        loadOrders(),
        loadSettings()
      ]);
    }

    async function loadSellers() {
      try {
        const res = await fetch('/api/sellers');
        if (res.ok) sellers.value = await res.json();
      } catch (e) {}
    }

    async function loadUsers() {
      try {
        const res = await fetch('/api/users');
        if (res.ok) usersList.value = await res.json();
      } catch (e) {}
    }

    async function loadCategories() {
      try {
        const res = await fetch('/api/categories');
        if (res.ok) categories.value = await res.json();
      } catch (e) {}
    }

    async function loadProducts() {
      loadingProducts.value = true;
      try {
        const res = await fetch('/api/products');
        if (res.ok) products.value = await res.json();
      } catch (e) {} finally {
        loadingProducts.value = false;
      }
    }

    async function loadOrders() {
      try {
        const res = await fetch('/api/orders');
        if (res.ok) orders.value = await res.json();
      } catch (e) {}
    }

    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          discordWebhookUrl.value = data.discord_webhook_url || '';
        }
      } catch (e) {}
    }

    // ------------------------------------------------------------------------
    // 5. 前台商品瀏覽與篩選
    // ------------------------------------------------------------------------
    const selectedCategory = ref('全部');
    const searchKeyword = ref('');
    const selectedSellerFilter = ref('');

    const filteredProducts = computed(() => {
      return products.value.filter(p => {
        if (selectedCategory.value !== '全部' && !p.categories.includes(selectedCategory.value)) {
          return false;
        }
        if (selectedSellerFilter.value && String(p.seller.id) !== String(selectedSellerFilter.value)) {
          return false;
        }
        if (searchKeyword.value.trim()) {
          const kw = searchKeyword.value.trim().toLowerCase();
          const matchTitle = p.title.toLowerCase().includes(kw);
          const matchDesc = p.description && p.description.toLowerCase().includes(kw);
          const matchSeller = p.seller.name.toLowerCase().includes(kw);
          const matchVariants = p.variants.some(v => v.name.toLowerCase().includes(kw));
          if (!matchTitle && !matchDesc && !matchSeller && !matchVariants) {
            return false;
          }
        }
        return true;
      });
    });

    // ------------------------------------------------------------------------
    // 6. 購物車邏輯
    // ------------------------------------------------------------------------
    function loadInitialCart() {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.CART);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        }
      } catch (e) {}
      return [];
    }

    const cartItems = ref(loadInitialCart());
    const copiedFlags = reactive({});

    watch(cartItems, (val) => {
      try {
        localStorage.setItem(STORAGE_KEYS.CART, JSON.stringify(val));
      } catch (e) {}
    }, { deep: true });

    const isCartEmpty = computed(() => cartItems.value.length === 0);
    const cartCount = computed(() => cartItems.value.length);
    const cartTotalQuantity = computed(() => cartItems.value.reduce((acc, it) => acc + it.quantity, 0));
    const cartTotalCandy = computed(() => cartItems.value.reduce((acc, it) => acc + it.priceCandy * it.quantity, 0));

    const cartGroups = computed(() => {
      const map = new Map();
      for (const item of cartItems.value) {
        let grp = map.get(item.sellerId);
        if (!grp) {
          grp = {
            sellerId: item.sellerId,
            sellerName: item.sellerName,
            seller: {
              id: item.sellerId,
              name: item.sellerName,
              username: item.sellerName,
              display_name: item.sellerName,
              game_id: item.sellerGameId || null,
              discord_id: item.sellerDiscordId || null
            },
            items: [],
            totalCandy: 0,
            totalQuantity: 0
          };
          map.set(item.sellerId, grp);
        }
        grp.items.push(item);
        grp.totalCandy += item.priceCandy * item.quantity;
        grp.totalQuantity += item.quantity;
      }
      return [...map.values()];
    });

    const cartSellerCount = computed(() => cartGroups.value.length);

    function addToCart(product, variant = null) {
      const variantId = variant ? variant.id : null;
      const variantName = variant ? variant.name : null;
      const stock = variant ? variant.stock : product.stock;

      if (stock <= 0) {
        toast.info('此款式目前已無庫存');
        return;
      }

      const existing = cartItems.value.find(
        i => i.productId === product.id && (i.variantId ?? null) === (variantId ?? null)
      );

      if (existing) {
        if (existing.quantity >= stock) {
          toast.info(`已達庫存上限（最多 ${stock} 件）`);
          return;
        }
        existing.quantity += 1;
        existing.stockSnapshot = stock;
      } else {
        cartItems.value.push({
          productId: product.id,
          variantId: variantId,
          title: product.title,
          variantName: variantName,
          priceCandy: product.price_candy,
          thumbUrl: product.thumb_url,
          sellerId: product.seller.id,
          sellerName: product.seller.display_name || product.seller.name,
          sellerGameId: product.seller.game_id || null,
          sellerDiscordId: product.seller.discord_id || null,
          quantity: 1,
          stockSnapshot: stock
        });
      }

      const label = variantName ? `${product.title}（${variantName}）` : product.title;
      toast.success(`已加入購物車：「${label}」`);
    }

    function setCartQuantity(productId, variantId, newQty, maxStock) {
      if (newQty > maxStock) {
        toast.info(`目前只剩 ${maxStock} 件`);
        return;
      }
      const it = cartItems.value.find(
        i => i.productId === productId && (i.variantId ?? null) === (variantId ?? null)
      );
      if (!it) return;

      if (newQty <= 0) {
        removeCartItem(productId, variantId, it.title);
        return;
      }
      it.quantity = Math.min(newQty, Math.max(1, maxStock));
    }

    function removeCartItem(productId, variantId, title) {
      cartItems.value = cartItems.value.filter(
        i => !(i.productId === productId && (i.variantId ?? null) === (variantId ?? null))
      );
      toast.info(`已移除「${title}」`);
    }

    function removeCartSellerGroup(sellerId, sellerName) {
      cartItems.value = cartItems.value.filter(i => i.sellerId !== sellerId);
      toast.info(`已移除 ${sellerName} 的所有商品`);
    }

    function clearCart() {
      cartItems.value = [];
      toast.info('購物車已清空');
    }

    function getSellerContacts(seller) {
      if (!seller) return [];
      const res = [];
      if (seller.game_id && seller.game_id.trim()) {
        res.push({ ...CONTACT_SPECS.game, value: seller.game_id.trim() });
      }
      if (seller.discord_id && seller.discord_id.trim()) {
        res.push({ ...CONTACT_SPECS.discord, value: seller.discord_id.trim() });
      }
      return res;
    }

    async function copyContact(contact) {
      if (!contact.value) return;
      const ok = await copyToClipboard(contact.value);
      if (ok) {
        copiedFlags[contact.value] = true;
        setTimeout(() => { copiedFlags[contact.value] = false; }, 1800);
        toast.success(`已複製${contact.label}「${contact.value}」，${contact.copyHint}`);
      }
    }

    // ------------------------------------------------------------------------
    // 7. 結帳與下單 (寫入 SQLite 資料庫 + 自動推播 Discord)
    // ------------------------------------------------------------------------
    function loadInitialBuyer() {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.BUYER);
        if (raw) {
          const parsed = JSON.parse(raw);
          return {
            name: typeof parsed.name === 'string' ? parsed.name : '',
            gameId: typeof parsed.gameId === 'string' ? parsed.gameId : '',
            discordId: typeof parsed.discordId === 'string' ? parsed.discordId : '',
            gender: parsed.gender === 'male' || parsed.gender === 'female' ? parsed.gender : ''
          };
        }
      } catch (e) {}
      return { name: '', gameId: '', discordId: '', gender: '' };
    }

    const buyer = reactive(loadInitialBuyer());
    const buyerNote = ref('');
    const submittingOrder = ref(false);
    const checkoutError = ref('');
    const showOrderResultModal = ref(false);
    const lastOrders = ref([]);

    watch(buyer, (val) => {
      try {
        localStorage.setItem(STORAGE_KEYS.BUYER, JSON.stringify(val));
      } catch (e) {}
    }, { deep: true });

    const hasContact = computed(() => !!(buyer.gameId.trim() || buyer.discordId.trim()));
    const hasGender = computed(() => buyer.gender !== '');
    const canSubmitOrder = computed(() => !isCartEmpty.value && hasContact.value && hasGender.value && !submittingOrder.value);

    async function submitOrder() {
      checkoutError.value = '';
      if (!hasContact.value) {
        checkoutError.value = '請至少填寫遊戲 ID 或 DC ID，賣家才聯絡得到你';
        toast.error(checkoutError.value);
        return;
      }
      if (!hasGender.value) {
        checkoutError.value = '請選擇你的遊戲角色性別，賣家在遊戲裡才認得出你';
        toast.error(checkoutError.value);
        return;
      }
      if (isCartEmpty.value) return;

      submittingOrder.value = true;
      try {
        const orderPayloads = cartGroups.value.map(grp => ({
          seller_id: grp.seller.id,
          seller_name: grp.sellerName,
          buyer_name: buyer.name.trim() || null,
          buyer_game_id: buyer.gameId.trim() || null,
          buyer_discord_id: buyer.discordId.trim() || null,
          buyer_gender: buyer.gender,
          buyer_note: buyerNote.value.trim() || null,
          total_quantity: grp.totalQuantity,
          total_candy: grp.totalCandy,
          items: grp.items.map(it => ({
            product_id: it.productId,
            variant_id: it.variantId,
            product_title: it.title,
            variant_name: it.variantName,
            quantity: it.quantity,
            unit_candy: it.priceCandy,
            subtotal_candy: it.priceCandy * it.quantity,
            thumb_url: it.thumbUrl
          }))
        }));

        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders: orderPayloads })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || '送出訂單失敗');
        }

        const data = await res.json();
        const createdOrders = data.orders || [];

        lastOrders.value = createdOrders;
        cartItems.value = [];
        buyerNote.value = '';
        showOrderResultModal.value = true;
        loadOrders();

        const count = createdOrders.length;
        toast.success(count > 1 ? `已建立 ${count} 張訂單！(若有串接 Discord 已自動推播)` : '訂單已送出！已即時存入資料庫');
      } catch (err) {
        checkoutError.value = err.message;
        toast.error(err.message);
      } finally {
        submittingOrder.value = false;
      }
    }

    function formatOrderText(order) {
      const lines = [];
      lines.push(`【Mstar 糖果商城】訂單 ${order.order_no}`);
      lines.push(`賣家：${order.seller_name}`);
      const bContacts = [];
      if (order.buyer_game_id) bContacts.push(`遊戲 ID：${order.buyer_game_id}`);
      if (order.buyer_discord_id) bContacts.push(`DC ID：${order.buyer_discord_id}`);
      const cStr = bContacts.join('、');
      lines.push(`買家：${order.buyer_name ? `${order.buyer_name}（${cStr}）` : cStr || '未填'}`);
      lines.push(`角色性別：${order.buyer_gender === 'male' ? '男角' : order.buyer_gender === 'female' ? '女角' : '未填'}`);
      lines.push('');

      order.items.forEach((item, idx) => {
        const v = item.variant_name ? `（${item.variant_name}）` : '';
        lines.push(`${idx + 1}. ${item.product_title}${v} x${item.quantity}｜${formatNumber(item.subtotal_candy)} 顆`);
      });

      lines.push('');
      lines.push(`合計 ${order.total_quantity} 件｜${formatNumber(order.total_candy)} 顆糖果`);
      if (order.buyer_note) lines.push(`買家備註：${order.buyer_note}`);
      lines.push(`下單時間：${formatDateTime(order.created_at)}`);
      return lines.join('\n');
    }

    async function copySingleOrder(order) {
      const ok = await copyToClipboard(formatOrderText(order));
      if (ok) toast.success(`已複製訂單 ${order.order_no}！`);
    }

    async function copyAllOrders() {
      const text = lastOrders.value.map(formatOrderText).join('\n\n──────────\n\n');
      const ok = await copyToClipboard(text);
      if (ok) toast.success('已複製全部訂單文字！');
    }

    // ------------------------------------------------------------------------
    // 8. 後台商品上架
    // ------------------------------------------------------------------------
    const newProduct = reactive({
      seller_id: '',
      title: '',
      price_candy: 10,
      stock: 1,
      categories: ['傢俱'],
      thumb_url: '',
      description: '',
      has_variants: false,
      variants: [
        { name: '款式一', stock: 1 }
      ]
    });

    const isUploadingImage = ref(false);
    const imagePreview = ref('');

    watch(currentUser, (u) => {
      if (u && !newProduct.seller_id) {
        newProduct.seller_id = u.id;
      }
    }, { immediate: true });

    async function handleImageFileChange(e) {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        imagePreview.value = event.target.result;
      };
      reader.readAsDataURL(file);

      isUploadingImage.value = true;
      try {
        const base64Reader = new FileReader();
        base64Reader.readAsDataURL(file);
        base64Reader.onload = async () => {
          const res = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              base64: base64Reader.result
            })
          });
          const data = await res.json();
          if (res.ok && data.url) {
            newProduct.thumb_url = data.url;
            toast.success('圖片上傳成功！');
          } else {
            toast.error(data.error || '圖片上傳失敗');
          }
          isUploadingImage.value = false;
        };
      } catch (err) {
        toast.error('上傳出錯: ' + err.message);
        isUploadingImage.value = false;
      }
    }

    function addVariantRow() {
      newProduct.variants.push({
        name: `款式 ${newProduct.variants.length + 1}`,
        stock: 1
      });
    }

    function removeVariantRow(index) {
      if (newProduct.variants.length > 1) {
        newProduct.variants.splice(index, 1);
      }
    }

    const isSubmittingProduct = ref(false);
    async function submitCreateProduct() {
      if (!newProduct.seller_id) {
        toast.error('請先選擇上架賣家（上誰的名字）');
        return;
      }
      if (!newProduct.title.trim()) {
        toast.error('請填寫商品名稱');
        return;
      }
      if (newProduct.categories.length === 0) {
        toast.error('請至少勾選一個商品分類');
        return;
      }

      isSubmittingProduct.value = true;
      try {
        const variantsData = newProduct.has_variants
          ? newProduct.variants.map((v, idx) => ({ id: idx + 1, name: v.name.trim(), stock: Number(v.stock) || 1 }))
          : [];

        const payload = {
          seller_id: Number(newProduct.seller_id),
          title: newProduct.title.trim(),
          price_candy: Number(newProduct.price_candy) || 1,
          stock: newProduct.has_variants
            ? variantsData.reduce((sum, v) => sum + v.stock, 0)
            : (Number(newProduct.stock) || 1),
          categories: newProduct.categories,
          variants: variantsData,
          thumb_url: newProduct.thumb_url || null,
          description: newProduct.description.trim() || null
        };

        const res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || '上架失敗');
        }

        toast.success(`🎉 商品「${payload.title}」已發布至資料庫！`);
        
        newProduct.title = '';
        newProduct.price_candy = 10;
        newProduct.stock = 1;
        newProduct.thumb_url = '';
        imagePreview.value = '';
        newProduct.description = '';
        newProduct.has_variants = false;
        newProduct.variants = [{ name: '款式一', stock: 1 }];

        await loadProducts();
        adminTab.value = 'products';
      } catch (err) {
        toast.error('上架失敗: ' + err.message);
      } finally {
        isSubmittingProduct.value = false;
      }
    }

    async function deleteProduct(product) {
      if (!confirm(`確定要刪除「${product.title}」嗎？此操作將從資料庫移除。`)) return;
      try {
        const res = await fetch(`/api/products/${product.id}`, { method: 'DELETE' });
        if (res.ok) {
          toast.info(`已刪除「${product.title}」`);
          await loadProducts();
        }
      } catch (e) {
        toast.error('刪除失敗');
      }
    }

    // ------------------------------------------------------------------------
    // 9. 後台帳號與密碼管理 (User Management)
    // ------------------------------------------------------------------------
    const showAddUserModal = ref(false);
    const showEditUserModal = ref(false);
    const newUserForm = reactive({
      username: '',
      password: '',
      display_name: '',
      game_id: '',
      discord_id: '',
      role: 'seller'
    });

    const editingUser = reactive({
      id: null,
      username: '',
      password: '',
      display_name: '',
      game_id: '',
      discord_id: '',
      role: 'seller'
    });

    function openEditUser(user) {
      editingUser.id = user.id;
      editingUser.username = user.username;
      editingUser.password = user.password || '';
      editingUser.display_name = user.display_name;
      editingUser.game_id = user.game_id || '';
      editingUser.discord_id = user.discord_id || '';
      editingUser.role = user.role || 'seller';
      showEditUserModal.value = true;
    }

    async function submitAddUser() {
      if (!newUserForm.username.trim() || !newUserForm.password || !newUserForm.display_name.trim()) {
        toast.error('請填寫帳號、密碼與顯示名稱');
        return;
      }
      try {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newUserForm)
        });
        const data = await res.json();
        if (res.ok) {
          toast.success(`已成功建立賣家帳號「${data.username}」！`);
          showAddUserModal.value = false;
          newUserForm.username = '';
          newUserForm.password = '';
          newUserForm.display_name = '';
          newUserForm.game_id = '';
          newUserForm.discord_id = '';
          await Promise.all([loadUsers(), loadSellers()]);
        } else {
          toast.error(data.error || '建立帳號失敗');
        }
      } catch (e) {
        toast.error('連線出錯');
      }
    }

    async function submitEditUser() {
      if (!editingUser.display_name.trim()) {
        toast.error('顯示名稱不可為空');
        return;
      }
      try {
        const res = await fetch(`/api/users/${editingUser.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingUser)
        });
        const data = await res.json();
        if (res.ok) {
          toast.success(`帳號「${editingUser.username}」資料與密碼已更新！`);
          showEditUserModal.value = false;
          if (currentUser.value && currentUser.value.id === editingUser.id) {
            currentUser.value = { ...currentUser.value, ...data };
            localStorage.setItem(STORAGE_KEYS.AUTH, JSON.stringify(currentUser.value));
          }
          await Promise.all([loadUsers(), loadSellers()]);
        } else {
          toast.error(data.error || '修改失敗');
        }
      } catch (e) {
        toast.error('連線出錯');
      }
    }

    async function deleteUser(user) {
      if (currentUser.value && currentUser.value.id === user.id) {
        toast.error('無法刪除目前正在使用的登入帳號！');
        return;
      }
      if (!confirm(`確定要刪除帳號「${user.username} (${user.display_name})」嗎？此賣家的所有商品也會一併清理。`)) return;
      try {
        const res = await fetch(`/api/users/${user.id}`, { method: 'DELETE' });
        if (res.ok) {
          toast.info(`已刪除帳號「${user.username}」`);
          await Promise.all([loadUsers(), loadSellers(), loadProducts()]);
        }
      } catch (e) {
        toast.error('刪除失敗');
      }
    }

    // ------------------------------------------------------------------------
    // 10. Discord Webhook 設定與測試
    // ------------------------------------------------------------------------
    const isSavingDiscord = ref(false);
    const isTestingDiscord = ref(false);

    async function saveDiscordWebhook() {
      isSavingDiscord.value = true;
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discord_webhook_url: discordWebhookUrl.value.trim() })
        });
        if (res.ok) {
          toast.success('Discord Webhook 網址已儲存！');
        } else {
          toast.error('儲存失敗');
        }
      } catch (e) {
        toast.error('連線失敗');
      } finally {
        isSavingDiscord.value = false;
      }
    }

    async function testDiscordWebhook() {
      if (!discordWebhookUrl.value.trim()) {
        toast.error('請先輸入 Discord Webhook 網址');
        return;
      }
      isTestingDiscord.value = true;
      try {
        const res = await fetch('/api/test-discord', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhook_url: discordWebhookUrl.value.trim() })
        });
        const data = await res.json();
        if (res.ok) {
          toast.success('🎉 測試訊息已成功推播至您的 Discord 頻道！');
        } else {
          toast.error(data.error || 'Discord 發送失敗，請確認網址正確');
        }
      } catch (e) {
        toast.error('測試連線出錯');
      } finally {
        isTestingDiscord.value = false;
      }
    }

    // ------------------------------------------------------------------------
    // 11. 分類與訂單狀態管理
    // ------------------------------------------------------------------------
    const showAddCatModal = ref(false);
    const newCatName = ref('');
    const newCatIcon = ref('🏷️');

    async function submitAddCategory() {
      if (!newCatName.value.trim()) {
        toast.error('請輸入分類名稱');
        return;
      }
      try {
        const res = await fetch('/api/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newCatName.value.trim(),
            icon: newCatIcon.value.trim() || '🏷️'
          })
        });
        if (res.ok) {
          const cat = await res.json();
          await loadCategories();
          if (!newProduct.categories.includes(cat.name)) {
            newProduct.categories.push(cat.name);
          }
          showAddCatModal.value = false;
          newCatName.value = '';
          toast.success(`已新增分類「${cat.name}」！`);
        }
      } catch (e) {
        toast.error('新增分類失敗');
      }
    }

    async function updateOrderStatus(order, status) {
      try {
        const res = await fetch(`/api/orders/${order.order_no}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        if (res.ok) {
          order.status = status;
          toast.success(`訂單 ${order.order_no} 狀態已更新為：${status === 'completed' ? '已完成' : status === 'cancelled' ? '已取消' : '等賣家處理'}`);
        }
      } catch (e) {
        toast.error('更新訂單狀態失敗');
      }
    }

    return {
      currentUser,
      isLoggedIn,
      showLoginModal,
      loginForm,
      lockRemaining,
      handleLogin,
      handleLogout,
      currentView,
      adminTab,
      mobileMenuOpen,
      setView,
      toasts,
      toast,
      dismissToast,
      sellers,
      usersList,
      categories,
      products,
      orders,
      discordWebhookUrl,
      loadingProducts,
      selectedCategory,
      searchKeyword,
      selectedSellerFilter,
      filteredProducts,
      cartItems,
      isCartEmpty,
      cartCount,
      cartTotalQuantity,
      cartTotalCandy,
      cartGroups,
      cartSellerCount,
      copiedFlags,
      addToCart,
      setCartQuantity,
      removeCartItem,
      removeCartSellerGroup,
      clearCart,
      getSellerContacts,
      copyContact,
      buyer,
      buyerNote,
      submittingOrder,
      checkoutError,
      showOrderResultModal,
      lastOrders,
      GENDER_OPTIONS,
      hasContact,
      hasGender,
      canSubmitOrder,
      submitOrder,
      copySingleOrder,
      copyAllOrders,
      newProduct,
      isUploadingImage,
      imagePreview,
      showAddCatModal,
      newCatName,
      newCatIcon,
      handleImageFileChange,
      addVariantRow,
      removeVariantRow,
      submitCreateProduct,
      deleteProduct,
      showAddUserModal,
      showEditUserModal,
      newUserForm,
      editingUser,
      openEditUser,
      submitAddUser,
      submitEditUser,
      deleteUser,
      saveDiscordWebhook,
      testDiscordWebhook,
      isSavingDiscord,
      isTestingDiscord,
      submitAddCategory,
      updateOrderStatus,
      formatNumber,
      formatDateTime
    };
  }
}).mount('#app');
