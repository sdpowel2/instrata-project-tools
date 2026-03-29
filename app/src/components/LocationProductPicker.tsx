import { useMemo, useEffect } from 'react';
import { useStore } from '../store';

interface LocationProductPickerProps {
  projectId: string;
  selectedLocation?: string;
  selectedProduct?: string;
  onLocationChange: (loc: string | undefined) => void;
  onProductChange: (productId: string | undefined) => void;
}

export function LocationProductPicker({
  projectId,
  selectedLocation,
  selectedProduct,
  onLocationChange,
  onProductChange,
}: LocationProductPickerProps) {
  const bomItems = useStore((s) => s.projectBoM).filter(
    (b) => b.projectId === projectId,
  );

  const locations = useMemo(() => {
    const set = new Set<string>();
    for (const item of bomItems) {
      for (const loc of item.locations) {
        if (loc.room) set.add(loc.room);
      }
    }
    return Array.from(set).sort();
  }, [bomItems]);

  const filteredProducts = useMemo(() => {
    if (!selectedLocation) return bomItems;
    return bomItems.filter((item) =>
      item.locations.some((loc) => loc.room === selectedLocation),
    );
  }, [bomItems, selectedLocation]);

  // Reset product if it no longer appears in the filtered list
  useEffect(() => {
    if (
      selectedProduct &&
      !filteredProducts.some((p) => p.id === selectedProduct)
    ) {
      onProductChange(undefined);
    }
  }, [selectedProduct, filteredProducts, onProductChange]);

  return (
    <div className="grid grid-cols-2 gap-4">
      <label>
        <span className="text-sm font-medium">Location</span>
        <select
          className="input mt-1.5"
          value={selectedLocation ?? ''}
          onChange={(e) =>
            onLocationChange(e.target.value || undefined)
          }
        >
          <option value="">&mdash; All Locations &mdash;</option>
          {locations.map((loc) => (
            <option key={loc} value={loc}>
              {loc}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="text-sm font-medium">Product</span>
        <select
          className="input mt-1.5"
          value={selectedProduct ?? ''}
          onChange={(e) =>
            onProductChange(e.target.value || undefined)
          }
        >
          <option value="">&mdash; No Product &mdash;</option>
          {filteredProducts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.manufacturer} {item.model}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
